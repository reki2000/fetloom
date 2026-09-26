#!/usr/bin/env sh
set -eu
clang --target=wasm32 -O2 -fno-builtin -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=init_core -Wl,--export=set_device -Wl,--export=set_cap \
  -Wl,--export=clear_drives -Wl,--export=drive -Wl,--export=force_value \
  -Wl,--export=solve -Wl,--export=get_value \
  -Wl,--export=get_changed_count -Wl,--export=get_changed_net -Wl,--export=get_changed_value \
  -Wl,--strip-all \
  -o fetloom_core.wasm fetloom_core.c
