use std::path::Path;

use mxc_sdk::v1::{
    ContainerRequest, Containment, FilesystemPolicy, NetworkAction, NetworkEgressPolicy,
    NetworkIngressPolicy, NetworkPolicy,
};
use serde::Deserialize;

use crate::runner::validate_request;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol: u32,
    argv: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    timeout_ms: u32,
    read_only: Vec<String>,
    read_write: Vec<String>,
    denied: Vec<String>,
    network: bool,
}

pub fn request(request: Request) -> Result<ContainerRequest, String> {
    validate_request(request.protocol, request.timeout_ms, &request.cwd)?;
    if !request
        .argv
        .first()
        .is_some_and(|arg| Path::new(arg).is_absolute())
        || request.argv.iter().any(|arg| arg.contains('\0'))
    {
        return Err("Unsupported sandbox command.".into());
    }
    // MXC accepts a POSIX command line. Quote each argument independently.
    let command = request
        .argv
        .iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "'\"'\"'")))
        .collect::<Vec<_>>()
        .join(" ");
    let outbound = if request.network {
        NetworkAction::Allow
    } else {
        NetworkAction::Deny
    };
    Ok(ContainerRequest {
        containment: Containment::Bubblewrap,
        working_directory: Some(request.cwd),
        timeout_ms: Some(request.timeout_ms),
        environment: Some(request.env),
        inherit_default_environment: Some(false),
        filesystem: Some(FilesystemPolicy {
            readonly_paths: request.read_only,
            readwrite_paths: request.read_write,
            denied_paths: request.denied,
            ..Default::default()
        }),
        network: Some(NetworkPolicy {
            egress: Some(NetworkEgressPolicy {
                default: Some(outbound),
                ..Default::default()
            }),
            ingress: Some(NetworkIngressPolicy {
                default: Some(NetworkAction::Deny),
                host_loopback: Some(NetworkAction::Deny),
            }),
            ..Default::default()
        }),
        ..ContainerRequest::new(command)
    })
}
