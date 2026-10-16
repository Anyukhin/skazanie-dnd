//! `cargo run -p sk-corpus -- reducer <каталог корпуса> [тип команды]`
//! `cargo run -p sk-corpus -- resolve <каталог корпуса> <тип команды>[,<тип>…]`

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
        "resolve" => {
            let Some(kinds) = filter else {
                eprintln!("укажите тип команды: resolve <каталог> <тип>[,<тип>…]");
                std::process::exit(2);
            };
            for kind in kinds.split(',').filter(|kind| !kind.is_empty()) {
                let report = sk_corpus::check_resolve(&corpus, kind).expect("сверка разбора");
                println!("{}", report.render(kind));
            }
        }
        other => {
            eprintln!("неизвестный режим {other}; есть: reducer, resolve");
            std::process::exit(2);
        }
    }
}
