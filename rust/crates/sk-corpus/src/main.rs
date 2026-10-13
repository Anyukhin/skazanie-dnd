//! `cargo run -p sk-corpus -- reducer <каталог корпуса> [тип команды]`

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("reducer");
    let root = args.get(2).cloned().unwrap_or_else(|| "../tmp/corpus-v1".into());
    let filter = args.get(3).map(String::as_str);
    let corpus = sk_corpus::Corpus::open(&root).expect("корпус открывается");
    match mode {
        "reducer" => {
            let report = sk_corpus::check_reducer(&corpus, filter).expect("сверка редьюсера");
            print!("{}", report.render());
        }
        other => {
            eprintln!("неизвестный режим {other}; есть: reducer");
            std::process::exit(2);
        }
    }
}
