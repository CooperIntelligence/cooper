use semver::Version;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Command};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Channel {
    Latest,
    Alpha,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallState {
    active: Version,
    previous: Option<Version>,
    channel: Channel,
}

fn main() {
    match run() {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("Cooper launcher: {error}");
            process::exit(1);
        }
    }
}

fn run() -> Result<i32> {
    let executable = std::env::current_exe()?;
    let bin = executable.parent().ok_or("missing launcher directory")?;
    let root = bin
        .parent()
        .filter(|_| bin.file_name().is_some_and(|name| name == "bin"))
        .ok_or("install the launcher as bin/cooper.exe")?;
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();

    match args.as_slice() {
        [command, options @ ..] if command == "update" => {
            if !options.is_empty() && !matches!(options, [flag] if flag == "--check") {
                return Err("Usage: cooper update [--check]".into());
            }
            Err("Online updates are unavailable in this build.".into())
        }
        [command] if command == "rollback" => {
            change_version(root, None)?;
            Ok(0)
        }
        [command, ..] if command == "rollback" => Err("Usage: cooper rollback".into()),
        [command, version] if command == "--launcher-activate" => {
            let version = version.to_str().ok_or("expected a UTF-8 release version")?;
            change_version(root, Some(Version::parse(version)?))?;
            Ok(0)
        }
        [command, ..] if command == "--launcher-activate" => {
            Err("usage: cooper --launcher-activate <installed-version>".into())
        }
        [command, ..] if !command.to_string_lossy().starts_with('-') => Err(format!(
            "Unknown command: {}. Use -p to send a prompt, or try --help.",
            command.to_string_lossy()
        )
        .into()),
        _ => {
            let state = read_state(root)?;
            let program = installed_executable(root, &state.active)?;
            keep_launcher_alive_on_interrupt();
            let status = Command::new(&program)
                .args(args)
                .status()
                .map_err(|error| format!("could not start Cooper {}: {error}", state.active))?;
            Ok(status.code().unwrap_or(1))
        }
    }
}

fn read_state(root: &Path) -> Result<InstallState> {
    let path = root.join("current.json");
    let bytes = fs::read(&path).map_err(|error| format!("reading {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid {}: {error}", path.display()).into())
}

fn installed_executable(root: &Path, version: &Version) -> Result<PathBuf> {
    let path = root
        .join("versions")
        .join(version.to_string())
        .join("cooper.exe");
    if !path.is_file() {
        return Err(format!("Cooper {version} is missing at {}", path.display()).into());
    }
    Ok(path)
}

fn change_version(root: &Path, requested: Option<Version>) -> Result<()> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("install.lock"))?;
    lock.lock()?;
    let mut state = read_state(root)?;
    let selected = requested
        .or_else(|| state.previous.clone())
        .ok_or("there is no previous Cooper version to roll back to")?;
    installed_executable(root, &selected)?;
    if selected == state.active {
        return Ok(());
    }

    state.previous = Some(std::mem::replace(&mut state.active, selected));
    write_state(root, &state)?;
    println!("Cooper {} is active for new launches.", state.active);
    Ok(())
}

fn write_state(root: &Path, state: &InstallState) -> Result<()> {
    let next = root.join("current.next.json");
    match fs::remove_file(&next) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&next)?;
    serde_json::to_writer(&mut file, state)?;
    writeln!(file)?;
    file.sync_all()?;
    drop(file);
    // Readers see either the old state or the new one. The writer lock spans this rename.
    fs::rename(next, root.join("current.json"))?;
    Ok(())
}

#[cfg(windows)]
fn keep_launcher_alive_on_interrupt() {
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    extern "system" fn handle_interrupt(event: u32) -> i32 {
        const CTRL_C_EVENT: u32 = 0;
        const CTRL_BREAK_EVENT: u32 = 1;
        i32::from(matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT))
    }

    // The child gets console events independently. This handler keeps its parent waiting.
    unsafe { SetConsoleCtrlHandler(Some(handle_interrupt), 1) };
}

#[cfg(not(windows))]
compile_error!("the Cooper launcher currently targets Windows");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_and_rollback_commit_only_installed_versions() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path();
        let first = Version::parse("0.2.0-alpha.1")?;
        let second = Version::parse("0.2.0-alpha.2")?;
        let missing = Version::parse("0.2.0-alpha.3")?;
        for version in [&first, &second] {
            let installed = root.join("versions").join(version.to_string());
            fs::create_dir_all(&installed)?;
            fs::write(installed.join("cooper.exe"), b"stub")?;
        }
        write_state(
            root,
            &InstallState {
                active: first.clone(),
                previous: None,
                channel: Channel::Alpha,
            },
        )?;

        assert!(change_version(root, None).is_err());
        change_version(root, Some(second.clone()))?;
        assert!(change_version(root, Some(missing)).is_err());
        let state = read_state(root)?;
        assert_eq!(state.active, second);
        assert_eq!(state.previous, Some(first.clone()));

        fs::remove_file(installed_executable(root, &second)?)?;
        change_version(root, None)?;
        let state = read_state(root)?;
        assert_eq!(state.active, first);
        assert!(matches!(state.channel, Channel::Alpha));
        Ok(())
    }
}
