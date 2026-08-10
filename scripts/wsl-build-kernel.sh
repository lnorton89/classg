#!/usr/bin/env bash
# Build a WSL2 kernel with MediaTek MT7921U support, for the AWUS036AXML.
#
#   ./scripts/wsl-build-kernel.sh
#
# WHY THIS IS NEEDED
#   Microsoft's WSL2 kernel config sets "# CONFIG_MT7921U is not set" explicitly,
#   and ships no /lib/modules/$(uname -r)/build tree, so the driver can be neither
#   loaded nor built out-of-tree. Replacing the kernel is the only option.
#
# READ THIS BEFORE SPENDING 30 MINUTES
#   microsoft/WSL issue #12288 reports this EXACT chipset (0e8d:7961) attached
#   over usbipd crashing the WSL2 kernel during mt7921u init -- after firmware
#   loads, at driver probe. Reported on kernels 6.1 and 6.6; closed unresolved.
#
#   This script targets 6.18, which is many mt7921u fixes newer than that report,
#   so it may well work. But nobody has published a confirmed success on this
#   chipset. You are the experiment. If WSL dies the moment you attach the
#   adapter, that is #12288 and there is no known fix -- use a Pi or a live USB.
#
# Everything before the "attach" step is safe and reversible.

set -euo pipefail

# Match the running kernel so nothing is downgraded. Microsoft tags releases as
# linux-msft-wsl-<version>; the branch is linux-msft-wsl-6.18.y.
KERNEL_TAG="${KERNEL_TAG:-linux-msft-wsl-6.18.33.2}"
SRC_DIR="${SRC_DIR:-$HOME/WSL2-Linux-Kernel}"
WIN_USER="${WIN_USER:-$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n' || echo Lawrence)}"
OUT_IMAGE="/mnt/c/Users/$WIN_USER/wsl-kernel-classg"

if ! grep -qi microsoft /proc/version; then
    echo "This script is only for WSL. On a Pi or live USB the driver is already in-tree." >&2
    exit 1
fi

echo "==> running kernel : $(uname -r)"
echo "==> building tag   : $KERNEL_TAG"
echo "==> output image   : $OUT_IMAGE"
echo

# ---------------------------------------------------------------------------
echo "==> [1/6] build dependencies"
sudo apt-get update
sudo apt-get install -y \
    build-essential flex bison libssl-dev libelf-dev bc dwarves pahole \
    cpio kmod python3 git tcpdump iw usbutils rfkill

# ---------------------------------------------------------------------------
echo "==> [2/6] MT7961 firmware"
# The driver loads firmware BEFORE probe. Missing blobs produce a different
# (and much more obvious) failure than the #12288 crash, so get them in place
# first to keep the diagnosis clean.
shopt -s nullglob
MT7961_FIRMWARE=(/lib/firmware/mediatek/*7961*)
if [ "${#MT7961_FIRMWARE[@]}" -eq 0 ]; then
    if ! sudo apt-get install -y firmware-misc-nonfree 2>/dev/null; then
        echo "    firmware-misc-nonfree unavailable (non-free-firmware component"
        echo "    probably not enabled); pulling blobs from linux-firmware instead"
        tmp=$(mktemp -d)
        git clone --depth 1 https://gitlab.com/kernel-firmware/linux-firmware.git "$tmp/lf"
        sudo mkdir -p /lib/firmware/mediatek
        sudo cp -r "$tmp/lf/mediatek/." /lib/firmware/mediatek/
        rm -rf "$tmp"
    fi
fi
MT7961_FIRMWARE=(/lib/firmware/mediatek/*7961*)
if [ "${#MT7961_FIRMWARE[@]}" -eq 0 ]; then
    echo "    ERROR: still no MT7961 firmware. Fix this before continuing." >&2
    exit 1
fi
printf '    %s\n' "${MT7961_FIRMWARE[@]##*/}"

# ---------------------------------------------------------------------------
echo "==> [3/6] kernel source"
if [ ! -d "$SRC_DIR" ]; then
    git clone --depth 1 --branch "$KERNEL_TAG" \
        https://github.com/microsoft/WSL2-Linux-Kernel.git "$SRC_DIR"
fi
cd "$SRC_DIR"

# ---------------------------------------------------------------------------
echo "==> [4/6] configure"
cp Microsoft/config-wsl .config

# The wireless stack is already =m in Microsoft's config; MediaTek USB is not.
scripts/config --enable  CONFIG_WIRELESS
scripts/config --module  CONFIG_CFG80211
scripts/config --module  CONFIG_MAC80211
scripts/config --enable  CONFIG_WLAN
scripts/config --enable  CONFIG_WLAN_VENDOR_MEDIATEK
scripts/config --module  CONFIG_MT76_CORE
scripts/config --module  CONFIG_MT76_USB
scripts/config --module  CONFIG_MT76_CONNAC_LIB
scripts/config --module  CONFIG_MT7921_COMMON
scripts/config --module  CONFIG_MT7921U
# WSL runs several distro mount namespaces on one kernel (notably Debian and
# docker-desktop). request_firmware() resolves from the kernel's initial mount
# namespace, so blobs visible at Debian's /lib/firmware can still return ENOENT.
# Compile the two blobs mt7921u needs into the image to make lookup independent
# of whichever WSL distro happened to establish that namespace.
scripts/config --set-str CONFIG_EXTRA_FIRMWARE \
    "mediatek/WIFI_MT7961_patch_mcu_1_2_hdr.bin mediatek/WIFI_RAM_CODE_MT7961_1.bin"
scripts/config --set-str CONFIG_EXTRA_FIRMWARE_DIR "/lib/firmware"
# usbip client side, for receiving the forwarded adapter
scripts/config --enable  CONFIG_USBIP_CORE
scripts/config --module  CONFIG_USBIP_VHCI_HCD
# Handy for confirming the radio is not soft-blocked
scripts/config --enable  CONFIG_RFKILL

make olddefconfig

echo "    verifying the options actually took:"
for opt in CONFIG_MT7921U CONFIG_MT76_USB CONFIG_CFG80211 CONFIG_MAC80211 CONFIG_EXTRA_FIRMWARE; do
    printf '      %-22s %s\n' "$opt" "$(grep -E "^($opt=|# $opt )" .config || echo MISSING)"
done
if grep -q "^# CONFIG_MT7921U is not set" .config; then
    echo "    ERROR: CONFIG_MT7921U did not stick. Aborting." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
echo "==> [5/6] build (this is the long part)"
make -j"$(nproc)"
sudo make modules_install

# ---------------------------------------------------------------------------
echo "==> [6/6] install image"
cp arch/x86/boot/bzImage "$OUT_IMAGE"
echo "    wrote $OUT_IMAGE"

cat <<EOS

============================================================================
Next steps (on Windows)
============================================================================

1. Add this line under [wsl2] in C:\\Users\\$WIN_USER\\.wslconfig :

       kernel=C:\\\\Users\\\\$WIN_USER\\\\wsl-kernel-classg

   NOTE: this applies to EVERY distro, including Docker Desktop's. If Docker
   misbehaves afterwards, remove the line to revert.

2. wsl --shutdown        (then reopen a shell)

3. Confirm the driver exists:
       modinfo mt7921u | head -3

4. Forward the adapter, from an ADMINISTRATOR PowerShell:
       usbipd bind   --busid 2-9
       usbipd attach --wsl --busid 2-9

   This removes the adapter from Windows while attached. Your Intel PCI card
   keeps Windows online.

   >>> If WSL dies at this instant, that is microsoft/WSL#12288. No known fix.
   >>> Fall back to the Pi or a live USB.

5. Then, in WSL:
       ./scripts/check-capture-env.sh

============================================================================
EOS
