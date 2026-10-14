//! Локальный провайдер для тестов на `127.0.0.1` в протоколе RouterAI/OpenAI
//! (как `startFakeProvider` в `test/kit/llm.mjs`). Сети нет: тесты не ходят
//! в интернет (инвариант проекта).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Принятый запрос.
#[derive(Debug, Clone, Default)]
pub(crate) struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// Ответ провайдера.
#[derive(Debug, Clone)]
pub(crate) enum Reply {
    /// Тело целиком (`Content-Length`).
    Full { status: u16, body: Vec<u8> },
    /// Поток кусками (`Transfer-Encoding: chunked`) с паузой между кусками;
    /// `fail` — соединение рвётся без завершающего куска.
    Chunks { status: u16, chunks: Vec<Vec<u8>>, delay_ms: u64, fail: bool },
    /// Заголовки и тело не приходят никогда.
    Hang,
    /// Соединение закрывается без ответа.
    Drop,
}

impl Reply {
    pub fn json(status: u16, body: &serde_json::Value) -> Reply {
        Reply::Full { status, body: serde_json::to_vec(body).unwrap_or_default() }
    }

    pub fn text(status: u16, body: &str) -> Reply {
        Reply::Full { status, body: body.as_bytes().to_vec() }
    }
}

pub(crate) type Handler = Arc<dyn Fn(&Recorded, usize) -> Reply + Send + Sync>;

pub(crate) struct TestServer {
    /// `http://127.0.0.1:{port}` без пути.
    pub origin: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    pub async fn start(handler: Handler) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("порт");
        let origin = format!("http://{}", listener.local_addr().expect("адрес"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else { break };
                let handler = Arc::clone(&handler);
                let requests = Arc::clone(&shared);
                tokio::spawn(async move {
                    let _ = serve(socket, handler, requests).await;
                });
            }
        });
        TestServer { origin, requests, task }
    }

    /// Сервер с одним и тем же ответом на любой запрос.
    pub async fn replying(reply: Reply) -> TestServer {
        Self::start(Arc::new(move |_, _| reply.clone())).await
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().expect("запросы").clone()
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

async fn serve(mut socket: TcpStream, handler: Handler, requests: Arc<Mutex<Vec<Recorded>>>) -> std::io::Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split(' ');
    let method = request_line.next().unwrap_or("").to_string();
    let path = request_line.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|line| line.split_once(':').map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))).collect();
    let length = headers.iter().find(|(key, _)| key.eq_ignore_ascii_case("content-length")).and_then(|(_, value)| value.parse::<usize>().ok()).unwrap_or(0);
    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    let recorded = Recorded { method, path, headers, body };
    let index = {
        let mut requests = requests.lock().expect("запросы");
        requests.push(recorded.clone());
        requests.len() - 1
    };
    match handler(&recorded, index) {
        Reply::Full { status, body } => {
            let head = if matches!(status, 204 | 205 | 304) {
                format!("HTTP/1.1 {status} {}\r\nConnection: close\r\n\r\n", reason(status))
            } else {
                format!("HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reason(status), body.len())
            };
            socket.write_all(head.as_bytes()).await?;
            if !matches!(status, 204 | 205 | 304) {
                socket.write_all(&body).await?;
            }
            socket.flush().await?;
            socket.shutdown().await?;
        }
        Reply::Chunks { status, chunks, delay_ms, fail } => {
            let head = format!("HTTP/1.1 {status} {}\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", reason(status));
            socket.write_all(head.as_bytes()).await?;
            socket.flush().await?;
            for piece in chunks.iter().filter(|piece| !piece.is_empty()) {
                socket.write_all(format!("{:x}\r\n", piece.len()).as_bytes()).await?;
                socket.write_all(piece).await?;
                socket.write_all(b"\r\n").await?;
                socket.flush().await?;
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
            }
            if fail {
                // Обрыв посреди тела: без завершающего куска.
                return Ok(());
            }
            socket.write_all(b"0\r\n\r\n").await?;
            socket.flush().await?;
            socket.shutdown().await?;
        }
        Reply::Hang => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
        Reply::Drop => {}
    }
    Ok(())
}
