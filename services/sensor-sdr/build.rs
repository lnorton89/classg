//! Locate librtlsdr, and only when the `rtlsdr` feature asks for it.
//!
//! The RTL-SDR Blog fork is built from source (ADR-0004 requires it over the
//! stock library), and `make install` puts it in /usr/local/lib, which is not
//! on the default linker search path on Raspberry Pi OS. Without this the build
//! fails with an unresolved `rtlsdr_open` that says nothing about why.
//!
//! No `pkg-config` crate: this shells out to the tool when it exists and falls
//! back to the fork's install prefix when it does not, which is the same
//! no-dependency trade the rest of this crate makes.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RTLSDR_LIB_DIR");

    if std::env::var_os("CARGO_FEATURE_RTLSDR").is_none() {
        return;
    }

    // An explicit override wins: a cross-build or a non-standard prefix has no
    // reason to be guessed at.
    if let Some(dir) = std::env::var_os("RTLSDR_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", dir.to_string_lossy());
        return;
    }

    if let Ok(out) = Command::new("pkg-config")
        .args(["--libs", "librtlsdr"])
        .output()
    {
        if out.status.success() {
            let flags = String::from_utf8_lossy(&out.stdout);
            for token in flags.split_whitespace() {
                if let Some(path) = token.strip_prefix("-L") {
                    println!("cargo:rustc-link-search=native={path}");
                }
            }
            return;
        }
    }

    // Where the Blog fork's own build instructions leave it.
    println!("cargo:rustc-link-search=native=/usr/local/lib");
}
