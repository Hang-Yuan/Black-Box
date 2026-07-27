// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "--auxiliary-model-hook")
    {
        if arguments.len() != 2 {
            eprintln!("--auxiliary-model-hook requires exactly one auxiliary model");
            std::process::exit(1);
        }
        if let Err(error) = blackbox_lib::run_auxiliary_model_hook(arguments[1].clone()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|value| value == "--time-context-hook")
    {
        if arguments.len() != 1 {
            eprintln!("--time-context-hook does not accept arguments");
            std::process::exit(1);
        }
        if let Err(error) = blackbox_lib::run_time_context_hook() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .first()
        .is_some_and(|value| value == "--automation-tool")
    {
        match blackbox_lib::run_automation_cli(&arguments[1..]) {
            Ok(output) => {
                println!("{output}");
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    blackbox_lib::run()
}
