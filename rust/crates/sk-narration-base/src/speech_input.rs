//! Перенос `server/speech-input.mjs`: голосовой ввод через локальный Whisper.
//!
//! Запись принимается только в одной форме — WAV PCM, один канал, 16 кГц,
//! 16 бит, до 60 секунд — и проверяется до запуска распознавания. Распознаёт
//! внешняя программа (`DND_WHISPER_EXECUTABLE` с моделью `DND_WHISPER_MODEL`);
//! одновременно идёт не больше одного распознавания (`429` второму запросу).
//!
//! В JS ошибки — `Error` с полем `status` у тех, что уходят клиенту кодом HTTP;
//! здесь — [`SpeechError`] с тем же текстом и `status`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sk_core::{re, text};

/// Заголовок 44 байта + минута 16-битного моно 16 кГц.
const MAX_AUDIO: usize = 44 + 16_000 * 2 * 60;
const RUN_TIMEOUT: Duration = Duration::from_millis(120_000);
const MAX_BUFFER: usize = 1_000_000;

static BUSY: AtomicBool = AtomicBool::new(false);

/// Ошибка голосового ввода: текст для игрока и, если есть, код HTTP.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SpeechError {
    pub message: String,
    pub status: Option<u16>,
}

impl SpeechError {
    fn new(message: &str, status: Option<u16>) -> Self {
        Self { message: message.to_string(), status }
    }
}

fn configuration() -> (Option<String>, Option<String>) {
    let read = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    (read("DND_WHISPER_EXECUTABLE"), read("DND_WHISPER_MODEL"))
}

/// `speechInputAvailable()`: заданы ли программа и модель и существуют ли файлы.
pub fn speech_input_available() -> bool {
    match configuration() {
        (Some(executable), Some(model)) => Path::new(&executable).exists() && Path::new(&model).exists(),
        _ => false,
    }
}

/// `buffer.toString('ascii', start, end)`: Node при декодировании `ascii`
/// снимает старший бит каждого байта.
fn ascii(audio: &[u8], start: usize, end: usize) -> String {
    audio[start..end].iter().map(|byte| char::from(byte & 0x7f)).collect()
}

fn u32_le(audio: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([audio[offset], audio[offset + 1], audio[offset + 2], audio[offset + 3]])
}

fn u16_le(audio: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([audio[offset], audio[offset + 1]])
}

/// `validateSpeechWav(audio)`: та же запись, если это WAV нужной формы.
pub fn validate_speech_wav(audio: &[u8]) -> Result<&[u8], SpeechError> {
    let length = audio.len();
    let valid = (46..=MAX_AUDIO).contains(&length)
        && ascii(audio, 0, 4) == "RIFF"
        && u32_le(audio, 4) as usize == length - 8
        && ascii(audio, 8, 16) == "WAVEfmt "
        && u32_le(audio, 16) == 16
        && u16_le(audio, 20) == 1
        && u16_le(audio, 22) == 1
        && u32_le(audio, 24) == 16_000
        && u32_le(audio, 28) == 32_000
        && u16_le(audio, 32) == 2
        && u16_le(audio, 34) == 16
        && ascii(audio, 36, 40) == "data"
        && u32_le(audio, 40) as usize == length - 44
        && (length - 44) % 2 == 0;
    if valid {
        Ok(audio)
    } else {
        Err(SpeechError::new("Нужна запись WAV: один канал, 16 кГц, до 60 секунд.", None))
    }
}

/// `readSpeechWav(req)`: прочитать тело запроса, не принимая больше минуты записи.
pub fn read_speech_wav(mut reader: impl Read) -> Result<Vec<u8>, SpeechError> {
    let mut audio = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk).map_err(|cause| SpeechError { message: cause.to_string(), status: None })?;
        if read == 0 {
            break;
        }
        if audio.len() + read > MAX_AUDIO {
            return Err(SpeechError::new("Запись превышает 60 секунд.", None));
        }
        audio.extend_from_slice(&chunk[..read]);
    }
    validate_speech_wav(&audio)?;
    Ok(audio)
}

struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// Временный каталог `skazanie-speech-XXXXXX` (как `mkdtemp`).
fn make_temp_directory() -> std::io::Result<PathBuf> {
    loop {
        let suffix: String = sk_core::hash::uuid_v4().chars().filter(char::is_ascii_alphanumeric).take(6).collect();
        let directory = std::env::temp_dir().join(format!("skazanie-speech-{suffix}"));
        match std::fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(cause) => return Err(cause),
        }
    }
}

/// Счётчик вывода дочернего процесса: сам вывод не нужен, как и в JS, но
/// больше `maxBuffer` на любом из потоков — отказ.
fn drain(mut stream: impl Read + Send + 'static, overflow: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut total = 0usize;
        let mut buffer = [0u8; 8192];
        while let Ok(read) = stream.read(&mut buffer) {
            if read == 0 {
                break;
            }
            total += read;
            if total > MAX_BUFFER {
                overflow.store(true, Ordering::SeqCst);
            }
        }
    })
}

/// `execFile(executable, args, { windowsHide, timeout: 120000, maxBuffer: 1000000 })`.
fn run(executable: &str, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|cause| cause.to_string())?;
    let overflow = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = [child.stdout.take().map(|out| drain(out, Arc::clone(&overflow))), child.stderr.take().map(|err| drain(err, Arc::clone(&overflow)))]
        .into_iter()
        .flatten()
        .collect();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|cause| cause.to_string())? {
            break Some(status);
        }
        if overflow.load(Ordering::SeqCst) || started.elapsed() >= RUN_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    for reader in readers {
        let _ = reader.join();
    }
    match status {
        Some(status) if status.success() && !overflow.load(Ordering::SeqCst) => Ok(()),
        Some(status) => Err(format!("процесс завершился: {status}")),
        None => Err("процесс остановлен по времени или объёму вывода".into()),
    }
}

/// `transcribeSpeech(audio)`: распознанный текст (пробелы схлопнуты, до 12 000
/// символов). Занятость — `429`, не настроено — `503`, сбой распознавания — `502`.
pub fn transcribe_speech(audio: &[u8]) -> Result<String, SpeechError> {
    validate_speech_wav(audio)?;
    let busy = || SpeechError::new("Сервис занят, повторите через несколько секунд.", Some(429));
    if BUSY.load(Ordering::SeqCst) {
        return Err(busy());
    }
    if !speech_input_available() {
        return Err(SpeechError::new("Локальное распознавание ещё не настроено на сервере.", Some(503)));
    }
    // Повторная проверка после проверки файлов: второй запрос не обходит блокировку.
    if BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(busy());
    }
    let _guard = BusyGuard;
    let failed = || SpeechError::new("Не удалось распознать запись. Попробуйте более короткую фразу.", Some(502));
    let directory = make_temp_directory().map_err(|_| failed())?;
    let result = (|| -> Result<String, ()> {
        let input = directory.join("recording.wav");
        let output = directory.join("transcript");
        std::fs::write(&input, audio).map_err(|_| ())?;
        let (executable, model) = configuration();
        let (executable, model) = (executable.unwrap_or_default(), model.unwrap_or_default());
        let (input_text, output_text) = (input.to_string_lossy().into_owned(), output.to_string_lossy().into_owned());
        run(&executable, &["-m", &model, "-f", &input_text, "-l", "ru", "-otxt", "-of", &output_text, "-nt", "-np", "-t", "4"]).map_err(|_| ())?;
        let bytes = std::fs::read(format!("{output_text}.txt")).map_err(|_| ())?;
        let transcript = String::from_utf8_lossy(&bytes);
        let collapsed = text::replace_all(re!(r"\s+", "gu"), text::trim(&transcript), " ");
        Ok(text::head(&collapsed, 12_000))
    })();
    // Как `finally` в JS: сбой удаления каталога перекрывает и текст, и ошибку.
    std::fs::remove_dir_all(&directory).map_err(|cause| SpeechError { message: cause.to_string(), status: None })?;
    result.map_err(|_| failed())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WAV нужной формы с `samples` нулевыми отсчётами.
    pub(crate) fn wav(samples: usize) -> Vec<u8> {
        let data = samples * 2;
        let mut audio = Vec::with_capacity(44 + data);
        audio.extend_from_slice(b"RIFF");
        audio.extend_from_slice(&((36 + data) as u32).to_le_bytes());
        audio.extend_from_slice(b"WAVEfmt ");
        audio.extend_from_slice(&16u32.to_le_bytes());
        audio.extend_from_slice(&1u16.to_le_bytes());
        audio.extend_from_slice(&1u16.to_le_bytes());
        audio.extend_from_slice(&16_000u32.to_le_bytes());
        audio.extend_from_slice(&32_000u32.to_le_bytes());
        audio.extend_from_slice(&2u16.to_le_bytes());
        audio.extend_from_slice(&16u16.to_le_bytes());
        audio.extend_from_slice(b"data");
        audio.extend_from_slice(&(data as u32).to_le_bytes());
        audio.resize(44 + data, 0);
        audio
    }

    #[test]
    fn server_rejects_damaged_and_oversized_recordings() {
        let audio = wav(160);
        assert!(validate_speech_wav(&audio).is_ok());
        for offset in [0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40] {
            let mut bad = audio.clone();
            bad[offset] ^= 1;
            let error = validate_speech_wav(&bad).expect_err("повреждённый заголовок");
            assert_eq!(error.message, "Нужна запись WAV: один канал, 16 кГц, до 60 секунд.");
        }
        assert!(validate_speech_wav(&[0u8; 10]).is_err());
        assert!(validate_speech_wav(&wav(16_000 * 60)).is_ok(), "ровно минута допустима");
        assert!(validate_speech_wav(&wav(16_000 * 60 + 1)).is_err());
        let chunks = std::io::Cursor::new(audio.clone());
        assert_eq!(read_speech_wav(chunks.take(20).chain(std::io::Cursor::new(audio[20..].to_vec()))).expect("запись").len(), audio.len());
        let error = read_speech_wav(std::io::Cursor::new(vec![0u8; 2_000_000])).expect_err("слишком длинная");
        assert_eq!(error.message, "Запись превышает 60 секунд.");
    }

    /// Весь путь распознавания: без настройки — 503, с подставной программой
    /// вместо Whisper — текст из `<output>.txt`, временный каталог убран.
    /// Переменные окружения трогает только этот тест.
    #[test]
    fn transcription_runs_the_configured_program() {
        std::env::remove_var("DND_WHISPER_EXECUTABLE");
        std::env::remove_var("DND_WHISPER_MODEL");
        let audio = wav(160);
        assert_eq!(transcribe_speech(&[0u8; 10]).expect_err("не WAV").status, None);
        let error = transcribe_speech(&audio).expect_err("не настроено");
        assert_eq!((error.status, error.message.as_str()), (Some(503), "Локальное распознавание ещё не настроено на сервере."));
        assert!(!speech_input_available());

        let directory = std::env::temp_dir().join(format!("sk-speech-test-{}", sk_core::hash::uuid_v4()));
        std::fs::create_dir_all(&directory).expect("каталог");
        let model = directory.join("model.bin");
        std::fs::write(&model, b"model").expect("модель");
        // Аргументы: -m model -f input -l ru -otxt -of output … — выход девятый.
        #[cfg(windows)]
        let program = {
            let path = directory.join("fake-whisper.cmd");
            std::fs::write(&path, "@echo off\r\necho   hello    world   > \"%~9.txt\"\r\n").expect("программа");
            path
        };
        #[cfg(not(windows))]
        let program = {
            use std::os::unix::fs::PermissionsExt;
            let path = directory.join("fake-whisper.sh");
            std::fs::write(&path, "#!/bin/sh\nprintf '  hello    world  \\n' > \"$9.txt\"\n").expect("программа");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("права");
            path
        };
        std::env::set_var("DND_WHISPER_EXECUTABLE", &program);
        std::env::set_var("DND_WHISPER_MODEL", &model);
        assert!(speech_input_available());
        assert_eq!(transcribe_speech(&audio).expect("распознавание"), "hello world");
        assert!(!BUSY.load(Ordering::SeqCst), "блокировка снята");

        std::fs::write(&program, if cfg!(windows) { "@echo off\r\nexit /b 3\r\n" } else { "#!/bin/sh\nexit 3\n" }).expect("программа");
        let error = transcribe_speech(&audio).expect_err("сбой программы");
        assert_eq!((error.status, error.message.as_str()), (Some(502), "Не удалось распознать запись. Попробуйте более короткую фразу."));
        std::env::remove_var("DND_WHISPER_EXECUTABLE");
        std::env::remove_var("DND_WHISPER_MODEL");
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn ascii_check_ignores_the_high_bit_like_node() {
        // `toString('ascii')` в Node снимает старший бит: «RIFF» с битом 0x80 проходит.
        let mut audio = wav(10);
        audio[0] |= 0x80;
        assert!(validate_speech_wav(&audio).is_ok());
    }
}
