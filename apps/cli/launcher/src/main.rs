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
    Internal,
}

fn internal_launcher() -> bool {
    option_env!("COOPER_LAUNCHER_BUILD_CHANNEL") == Some("internal")
}

fn internal_version(version: &Version) -> bool {
    version.build.as_str().split('.').next() == Some("internal")
}

fn check_version_channel(version: &Version, internal: bool) -> Result<()> {
    if internal_version(version) != internal {
        return Err("The installed version must belong to the launcher's build channel.".into());
    }
    Ok(())
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
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if matches!(args.as_slice(), [flag] if flag == "--launcher-version") {
        println!(
            "{}",
            option_env!("COOPER_LAUNCHER_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
        );
        return Ok(0);
    }

    let executable = std::env::current_exe()?;
    let expected_name = if internal_launcher() {
        "cooper-internal.exe"
    } else {
        "cooper.exe"
    };
    if !executable
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(expected_name))
    {
        return Err(format!("Install the launcher as bin/{expected_name}.").into());
    }
    let bin = executable.parent().ok_or("missing launcher directory")?;
    let root = bin
        .parent()
        .filter(|_| bin.file_name().is_some_and(|name| name == "bin"))
        .ok_or("missing installation root above the bin directory")?;
    match args.as_slice() {
        [command, options @ ..] if command == "update" => {
            if !options.is_empty() && !matches!(options, [flag] if flag == "--check") {
                return Err("Usage: cooper update [--check]".into());
            }
            Err("Online updates are unavailable in this build.".into())
        }
        [command] if command == "rollback" => {
            let _running = hold_launch_lock(root)?;
            change_version(root, None)?;
            Ok(0)
        }
        [command, ..] if command == "rollback" => Err("Usage: cooper rollback".into()),
        [command, version] if command == "--launcher-setup" => {
            let version = version.to_str().ok_or("expected a UTF-8 release version")?;
            setup_version(root, Version::parse(version)?, internal_launcher())?;
            Ok(0)
        }
        [command, version] if command == "--launcher-activate" => {
            let version = version.to_str().ok_or("expected a UTF-8 release version")?;
            let _running = hold_launch_lock(root)?;
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
            let _running = hold_launch_lock(root)?;
            let state = read_state(root)?;
            if matches!(state.channel, Channel::Internal) != internal_launcher() {
                return Err("This installation belongs to a different build channel.".into());
            }
            check_version_channel(&state.active, internal_launcher())?;
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

fn open_lock(root: &Path, name: &str) -> io::Result<fs::File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(name))
}

fn hold_launch_lock(root: &Path) -> Result<fs::File> {
    // Setup and uninstall open this file with exclusive sharing.
    open_lock(root, "run.lock")
        .map_err(|error| format!("could not open Cooper's launch lock: {error}").into())
}

fn setup_version(root: &Path, version: Version, internal: bool) -> Result<()> {
    check_version_channel(&version, internal)?;
    let lock = open_lock(root, "install.lock")?;
    lock.lock()?;
    installed_executable(root, &version)?;
    // A fresh installation or a repair of unreadable state starts without a rollback target.
    let previous = read_state(root).ok().and_then(|state| {
        [Some(state.active), state.previous]
            .into_iter()
            .flatten()
            .find(|candidate| {
                *candidate != version
                    && internal_version(candidate) == internal
                    && installed_executable(root, candidate).is_ok()
            })
    });
    let channel = if internal {
        Channel::Internal
    } else if version.pre.as_str().starts_with("alpha.") {
        Channel::Alpha
    } else {
        Channel::Latest
    };
    write_state(
        root,
        &InstallState {
            active: version,
            previous,
            channel,
        },
    )
}

fn change_version(root: &Path, requested: Option<Version>) -> Result<()> {
    let lock = open_lock(root, "install.lock")?;
    lock.lock()?;
    let mut state = read_state(root)?;
    let internal = matches!(state.channel, Channel::Internal);
    check_version_channel(&state.active, internal)?;
    let selected = requested
        .or_else(|| state.previous.clone())
        .ok_or("there is no previous Cooper version to roll back to")?;
    check_version_channel(&selected, internal)?;
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
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn setup_exclusive_lock_blocks_launch_and_version_switching() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let setup_lock = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(dir.path().join("run.lock"))?;
        assert!(hold_launch_lock(dir.path()).is_err());
        drop(setup_lock);
        assert!(hold_launch_lock(dir.path()).is_ok());
        Ok(())
    }

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

    #[test]
    fn internal_setup_keeps_rollback_inside_the_internal_channel() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path();
        let public = Version::parse("0.2.0-alpha.2")?;
        let first = Version::parse("0.2.0-alpha.2+internal.20261122.1")?;
        let second = Version::parse("0.2.0-alpha.2+internal.20261122.2")?;
        for version in [&public, &first, &second] {
            let directory = root.join("versions").join(version.to_string());
            fs::create_dir_all(&directory)?;
            fs::write(directory.join("cooper.exe"), b"stub")?;
        }
        assert!(setup_version(root, public.clone(), true).is_err());
        assert!(setup_version(root, first.clone(), false).is_err());
        setup_version(root, first.clone(), true)?;
        setup_version(root, second.clone(), true)?;
        let state = read_state(root)?;
        assert!(matches!(state.channel, Channel::Internal));
        assert_eq!(state.active, second);
        assert_eq!(state.previous, Some(first.clone()));
        assert!(change_version(root, Some(public)).is_err());
        change_version(root, None)?;
        assert_eq!(read_state(root)?.active, first);
        Ok(())
    }
}
