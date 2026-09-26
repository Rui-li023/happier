use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const HSETUP_FILENAME: &str = env!("HAPPIER_HSETUP_SIDECAR_FILENAME");

fn has_gzip_header(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

fn is_gzip_file(path: &std::path::Path) -> Result<bool, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(has_gzip_header(&bytes))
}

fn extend_candidates_with_resource_dir(
    candidates: &mut Vec<PathBuf>,
    resource_dir: &std::path::Path,
    hsetup_filename: &str,
    base_filename: &str,
) {
    candidates.push(resource_dir.join(hsetup_filename));
    candidates.push(resource_dir.join(base_filename));

    // When bundled as a "resource" (not as an externalBin in usr/bin), Tauri preserves the
    // relative resource path, so binaries land under `<resource_dir>/binaries/`.
    candidates.push(resource_dir.join("binaries").join(hsetup_filename));
    candidates.push(resource_dir.join("binaries").join(base_filename));
}

fn materialize_hsetup_candidate(
    source_path: &std::path::Path,
    cache_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    if !is_gzip_file(source_path)? {
        return std::fs::canonicalize(source_path).map_err(|error| error.to_string());
    }

    let base_filename = if HSETUP_FILENAME.ends_with(".exe") {
        "hsetup.exe"
    } else {
        "hsetup"
    };

    let metadata = std::fs::metadata(source_path).map_err(|error| error.to_string())?;
    let len = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let out_path = cache_dir.join(format!("{base_filename}-materialized-{len}-{modified}"));
    if out_path.is_file() {
        return std::fs::canonicalize(out_path).map_err(|error| error.to_string());
    }

    let gz_bytes = std::fs::read(source_path).map_err(|error| error.to_string())?;
    let mut decoder = flate2::read::GzDecoder::new(&gz_bytes[..]);
    let mut decoded = Vec::new();
    use std::io::Read;
    decoder
        .read_to_end(&mut decoded)
        .map_err(|error| error.to_string())?;

    let tmp_path = cache_dir.join(format!(
        ".{base_filename}-materialized-{len}-{modified}.tmp"
    ));
    std::fs::write(&tmp_path, decoded).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    std::fs::rename(&tmp_path, &out_path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    std::fs::canonicalize(out_path).map_err(|error| error.to_string())
}

fn resolve_candidate_variants(path: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(path.to_path_buf());
    if let Some(path_str) = path.to_str() {
        out.push(PathBuf::from(format!("{path_str}.gz")));
    }
    out
}

/// Where to look for hsetup, in order. A packaged build finds its own copy first: the bundle's
/// resources (Linux ships it there as a `.gz` resource), then beside the executable (macOS
/// `../Resources`, Windows next to the exe). The compile-time checkout (`CARGO_MANIFEST_DIR/binaries`)
/// is a development convenience only: a release build never consults it, so a build machine's
/// checkout cannot stand in for the bundle it produced.
fn hsetup_candidates(
    checkout_dir: Option<&std::path::Path>,
    resource_dir: Option<&std::path::Path>,
    exe_dir: Option<&std::path::Path>,
    hsetup_filename: &str,
    base_filename: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(checkout_dir) = checkout_dir {
        // `tauri dev` runs from the checkout, where the sidecar build writes the helper.
        candidates.push(checkout_dir.join("binaries").join(hsetup_filename));
        candidates.push(checkout_dir.join("binaries").join(base_filename));
    }
    if let Some(resource_dir) = resource_dir {
        extend_candidates_with_resource_dir(
            &mut candidates,
            resource_dir,
            hsetup_filename,
            base_filename,
        );
    }
    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join(hsetup_filename));
        candidates.push(exe_dir.join(base_filename));
        candidates.push(exe_dir.join("../Resources").join(hsetup_filename));
        candidates.push(exe_dir.join("../Resources").join(base_filename));
    }
    candidates
}

pub fn resolve_hsetup_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base_filename = if HSETUP_FILENAME.ends_with(".exe") {
        "hsetup.exe"
    } else {
        "hsetup"
    };

    let checkout_dir = cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let resource_dir = app.path().resource_dir().ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf));
    let candidates = hsetup_candidates(
        checkout_dir.as_deref(),
        resource_dir.as_deref(),
        exe_dir.as_deref(),
        HSETUP_FILENAME,
        base_filename,
    );

    let checked_paths = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    for candidate in candidates {
        for candidate in resolve_candidate_variants(&candidate) {
            if !candidate.is_file() {
                continue;
            }
            let cache_dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?;
            let cache_dir = cache_dir.join("systemTasks");
            std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
            return materialize_hsetup_candidate(&candidate, &cache_dir);
        }
    }

    Err(format!(
        "Unable to resolve bundled hsetup executor. Checked: {checked_paths}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn extend_candidates_with_resource_dir_includes_binaries_subdir() {
        let resource_dir = std::path::PathBuf::from("/tmp/resources");
        let mut candidates = Vec::new();
        extend_candidates_with_resource_dir(
            &mut candidates,
            &resource_dir,
            "hsetup-x86_64-unknown-linux-gnu",
            "hsetup",
        );
        assert!(candidates.iter().any(|path| path
            == &resource_dir
                .join("binaries")
                .join("hsetup-x86_64-unknown-linux-gnu")));
        assert!(candidates
            .iter()
            .any(|path| path == &resource_dir.join("binaries").join("hsetup")));
    }

    #[test]
    fn packaged_builds_resolve_resources_and_never_the_checkout() {
        let checkout = std::path::Path::new("/checkout/apps/ui/src-tauri");
        let resources = std::path::Path::new("/opt/Happier/usr/lib/Happier");
        let exe_dir = std::path::Path::new("/opt/Happier/usr/bin");
        let name = "hsetup-x86_64-unknown-linux-gnu";

        // Release (no checkout): the bundle's resources come first, then beside the executable.
        let release = hsetup_candidates(None, Some(resources), Some(exe_dir), name, "hsetup");
        assert_eq!(release.first(), Some(&resources.join(name)));
        assert!(release.iter().all(|path| !path.starts_with(checkout)));
        let first_exe = release
            .iter()
            .position(|path| path.starts_with(exe_dir))
            .unwrap();
        assert!(release[..first_exe]
            .iter()
            .all(|path| path.starts_with(resources)));

        // Development: the checkout's freshly built helper is still found first.
        let development = hsetup_candidates(
            Some(checkout),
            Some(resources),
            Some(exe_dir),
            name,
            "hsetup",
        );
        assert_eq!(
            development.first(),
            Some(&checkout.join("binaries").join(name))
        );
        assert_eq!(&development[2..], &release[..]);
    }

    #[test]
    fn materialize_hsetup_candidate_extracts_gzip_to_cache_dir() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let archive_path = tmp.path().join("hsetup.gz");
        let expected = b"#!/bin/sh\necho hi\n";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(expected).unwrap();
        let gz = encoder.finish().unwrap();
        std::fs::write(&archive_path, &gz).unwrap();

        assert!(is_gzip_file(&archive_path).unwrap());

        let extracted = materialize_hsetup_candidate(&archive_path, &cache_dir).unwrap();

        // We expect archive extraction to materialize a runnable file outside of the archive path.
        assert_ne!(extracted, std::fs::canonicalize(&archive_path).unwrap());
        assert_eq!(std::fs::read(&extracted).unwrap(), expected);
    }
}
