#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(windows, target_os = "linux"))]
mod runner;
#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    {
        runner::main(windows::request, "Windows MXC");
    }

    #[cfg(target_os = "linux")]
    {
        runner::main(linux::request, "Linux MXC Bubblewrap");
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        eprintln!("The Cooper shell sandbox supports Windows and Linux.");
        std::process::exit(1);
    }
}
