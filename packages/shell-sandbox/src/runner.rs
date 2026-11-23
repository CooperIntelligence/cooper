use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use mxc_sdk::v1::{self, ContainerRequest, WaitResult};
use serde::{Serialize, de::DeserializeOwned};

const PROTOCOL: u32 = 1;
const MAX_REQUEST_BYTES: u64 = 512 * 1024;
const MAX_OUTPUT_BYTES: usize = 32 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Reply {
    Exited {
        code: i32,
        stdout: String,
        stderr: String,
    },
    TimedOut {
        stdout: String,
        stderr: String,
    },
    Cancelled,
    Error {
        message: String,
    },
}

pub fn validate_request(protocol: u32, timeout_ms: u32, cwd: &str) -> Result<(), String> {
    if protocol != PROTOCOL
        || !(1_000..=600_000).contains(&timeout_ms)
        || !Path::new(cwd).is_absolute()
    {
        return Err("Unsupported sandbox request.".into());
    }
    Ok(())
}

pub fn main<T: DeserializeOwned>(
    prepare: fn(T) -> Result<ContainerRequest, String>,
    backend: &str,
) {
    let reply = execute(prepare, backend).unwrap_or_else(|message| Reply::Error { message });
    if serde_json::to_writer(io::stdout().lock(), &reply).is_err() {
        std::process::exit(1);
    }
}

fn execute<T: DeserializeOwned>(
    prepare: fn(T) -> Result<ContainerRequest, String>,
    backend: &str,
) -> Result<Reply, String> {
    let mut control = BufReader::new(io::stdin());
    let mut line = String::new();
    control
        .by_ref()
        .take(MAX_REQUEST_BYTES)
        .read_line(&mut line)
        .map_err(|err| format!("Could not read the sandbox request: {err}"))?;
    if !line.ends_with('\n') {
        return Err("Sandbox request is incomplete or too large.".into());
    }
    let request =
        serde_json::from_str(&line).map_err(|_| "Invalid sandbox request.".to_string())?;
    let options = prepare(request)?;
    let deadline = Instant::now()
        + Duration::from_millis(options.timeout_ms.expect("validated timeout").into());

    let (cancel, cancelled) = mpsc::channel();
    thread::spawn(move || {
        // The parent holds this pipe open. EOF also handles a parent crash.
        let _ = control.read(&mut [0_u8; 1]);
        let _ = cancel.send(());
    });
    let mut process = v1::spawn(options, Default::default())
        .map_err(|err| format!("Could not start the {backend} sandbox: {err}"))?;
    drop(process.take_stdin());
    let stdout = capture(process.take_stdout());
    let stderr = capture(process.take_stderr());

    let result = loop {
        match process.try_wait() {
            Ok(Some(code)) => break Ok(WaitResult::Exited(code)),
            Ok(None) => {}
            Err(err) => break Err(format!("Could not wait for the sandbox: {err}")),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            process
                .kill()
                .map_err(|err| format!("Could not stop the timed-out sandbox: {err}"))?;
            break Ok(WaitResult::TimedOut);
        }
        if cancelled.recv_timeout(remaining.min(Duration::from_millis(25)))
            != Err(mpsc::RecvTimeoutError::Timeout)
        {
            process
                .kill()
                .map_err(|err| format!("Could not cancel the sandbox: {err}"))?;
            process
                .wait()
                .map_err(|err| format!("Could not reap the cancelled sandbox: {err}"))?;
            return Ok(Reply::Cancelled);
        }
    };
    // Dropping the native job also closes any remaining descendant pipe writers.
    drop(process);
    let stdout = stdout
        .join()
        .map_err(|_| "Could not collect sandbox stdout.")?;
    let stderr = stderr
        .join()
        .map_err(|_| "Could not collect sandbox stderr.")?;
    match result? {
        WaitResult::Exited(code) => Ok(Reply::Exited {
            code,
            stdout,
            stderr,
        }),
        WaitResult::TimedOut => Ok(Reply::TimedOut { stdout, stderr }),
    }
}

fn capture(stream: Option<Box<dyn Read + Send>>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let Some(mut stream) = stream else {
            return String::new();
        };
        let mut chunk = [0; 8192];
        while let Ok(size @ 1..) = stream.read(&mut chunk) {
            let excess = (output.len() + size).saturating_sub(MAX_OUTPUT_BYTES);
            output.drain(..excess);
            output.extend_from_slice(&chunk[..size]);
        }
        String::from_utf8_lossy(&output).into_owned()
    })
}
