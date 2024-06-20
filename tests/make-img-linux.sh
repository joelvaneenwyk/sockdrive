#!/usr/bin/env bash

set -eax

if ! command -v "mkfs.fat" &>/dev/null; then
    echo "Please install 'dosfstools'"
    exit 1
fi

BRANCH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && cd .. && pwd)
TARGET_DIR="${BRANCH_DIR}/dist"
mkdir -p "${TARGET_DIR}"
cd "${TARGET_DIR}" || exit 2

# 1Mb
dd if=/dev/zero of=fat12.img bs=1048576 count=1
# 1MB
dd if=/dev/zero of=fat16.img bs=1048576 count=16
# 64Mb
dd if=/dev/zero of=fat32.img bs=1048576 count=64

mkfs.fat -F 12 fat12.img
mkfs.fat -F 16 fat16.img
mkfs.fat -F 32 fat32.img
