#![forbid(unsafe_code)]

#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    {
        windows::main();
    }

    #[cfg(not(windows))]
    {
        eprintln!("The Cooper shell sandbox currently supports Windows.");
        std::process::exit(1);
    }
}
