#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod runner;

fn main() {
    #[cfg(target_os = "linux")]
    {
        runner::main(linux::request, "Linux MXC Bubblewrap");
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("The Cooper shell sandbox supports Linux.");
        std::process::exit(1);
    }
}
