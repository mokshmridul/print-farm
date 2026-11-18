#!/bin/bash
# (Re)generate the shop's slicing profiles into /data/printer from this image's
# OrcaSlicer presets. Pure JSON work: nothing is sliced, nothing is fetched.
#
#   PRINTER_MACHINE          exact Orca machine preset, e.g. "Prusa MK4 0.4 nozzle"
#   PRINTER_MULTI_MATERIAL   1 = AMS/MMU/tool changer (automatic multicolour)
#   ADVANCED_PROFILES        1 = the owner uploads presets in admin; without
#                            PRINTER_MACHINE this starts from a generic Klipper one
#   PRINTER_DISPLAY_NAME     the printer's name in customer copy (advanced mode)
PF_COMPONENT=printer
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

machine=$(cenv PRINTER_MACHINE)
advanced=$(cenv ADVANCED_PROFILES 0)
multi=$(cenv PRINTER_MULTI_MATERIAL 0)
name=$(cenv PRINTER_DISPLAY_NAME)
[ -z "$machine" ] && [ "$advanced" = 1 ] && machine="MyKlipper 0.4 nozzle"

if [ -z "$machine" ]; then
  # The committed Bambu Lab A1 set inside the worker is used; nothing to make.
  rm -f "$PRINTER_DIR/.stamp"
  exit 0
fi

stamp="orca=$(cenv ORCA_VERSION unknown)|machine=$machine|multi=$multi|name=$name"
if [ -f "$PRINTER_DIR/.stamp" ] && [ "$(<"$PRINTER_DIR/.stamp")" = "$stamp" ] && [ -s "$PRINTER_DIR/printer.json" ]; then
  exit 0
fi

flags=()
[ "$multi" = 1 ] && flags+=(--multi-material)
[ -n "$name" ] && flags+=(--name "$name")

tmp=$(mktemp -d "$DATA_DIR/.printer.XXXXXX")
log "Generating slicing profiles for: $machine"
if ! node /app/worker/dist/profile-gen.js generate "$machine" "$tmp" "${flags[@]}" >&2; then
  rm -rf "$tmp"
  die "Could not build slicing profiles for PRINTER_MACHINE=\"$machine\".
  It must be an exact OrcaSlicer machine preset name, e.g. \"Bambu Lab A1 0.4 nozzle\".
  List them with: docker run --rm --entrypoint node <image> /app/worker/dist/profile-gen.js list"
fi
printf '%s' "$stamp" > "$tmp/.stamp"
chmod 0755 "$tmp"
chmod -R a+rX "$tmp"
rm -rf "$PRINTER_DIR.old"
[ -d "$PRINTER_DIR" ] && mv "$PRINTER_DIR" "$PRINTER_DIR.old"
mv "$tmp" "$PRINTER_DIR"
rm -rf "$PRINTER_DIR.old"
log "Slicing profiles ready"
