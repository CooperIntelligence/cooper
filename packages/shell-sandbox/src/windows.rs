use mxc_sdk::v1::configs::{ProcessContainerConfig, ProcessContainerFilesystem};
use mxc_sdk::v1::{
    ContainerRequest, Containment, FilesystemPolicy, NetworkAction, NetworkEgressPolicy,
    NetworkIngressPolicy, NetworkPolicy, UiPolicy,
};
use serde::Deserialize;

use crate::runner::validate_request;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol: u32,
    command_line: String,
    cwd: String,
    env: Vec<(String, String)>,
    timeout_ms: u32,
    read_only: Vec<String>,
    read_write: Vec<String>,
    denied: Vec<String>,
    enumerate: Vec<String>,
}

pub fn request(request: Request) -> Result<ContainerRequest, String> {
    validate_request(request.protocol, request.timeout_ms, &request.cwd)?;
    // A native PSEC capability required for this policy.
    if request.enumerate.is_empty()
        || request.command_line.trim().is_empty()
        || request.command_line.contains('\0')
    {
        return Err("Unsupported sandbox request.".into());
    }

    let mut filesystem = ProcessContainerFilesystem::default();
    filesystem.enumerate_paths = request.enumerate;
    let mut containment = ProcessContainerConfig::default();
    containment.filesystem = Some(filesystem);
    Ok(ContainerRequest {
        containment: Containment::ProcessContainer(containment),
        working_directory: Some(request.cwd),
        timeout_ms: Some(request.timeout_ms),
        environment: Some(request.env),
        inherit_default_environment: Some(false),
        // Console processes need access to an isolated desktop to initialize.
        // Clipboard access and input injection remain disabled by the SDK defaults.
        ui: Some(UiPolicy {
            disable: false,
            ..Default::default()
        }),
        filesystem: Some(FilesystemPolicy {
            readonly_paths: request.read_only,
            readwrite_paths: request.read_write,
            denied_paths: request.denied,
            ..Default::default()
        }),
        network: Some(NetworkPolicy {
            egress: Some(NetworkEgressPolicy {
                default: Some(NetworkAction::Deny),
                ..Default::default()
            }),
            ingress: Some(NetworkIngressPolicy {
                default: Some(NetworkAction::Deny),
                host_loopback: Some(NetworkAction::Deny),
            }),
            ..Default::default()
        }),
        ..ContainerRequest::new(request.command_line)
    })
}
