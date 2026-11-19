#!/bin/bash
# (Re)generate the shop's slicing profiles into /data/printer from this image's
# OrcaSlicer presets. Pure JSON work: nothing is sliced, nothing is fetched.
#
#   PRINTER_MACHINE          exact Orca machine preset, e.g. "Prusa MK4 0.4 nozzle"
#   PRINTER_MULTI_MATERIAL   1 = AMS/MMU/tool changer (automatic multicolour)
#   ADVANCED_PROFILES        1 = the owner uploads presets in admin
#   PRINTER_DISPLAY_NAME     the printer's name in customer copy (advanced mode)
#
# There is no default printer. Without PRINTER_MACHINE — or in advanced mode
# on one of OrcaSlicer's generic bases (My* presets) — the set is a generic
# Klipper (or that base) stand-in marked as a placeholder: the shop takes no
# quotes until the owner's own printer preset is live (advanced_profiles in
# common.sh turns advanced mode on for this).
PF_COMPONENT=printer
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

machine=$(cenv PRINTER_MACHINE)
advanced=$(cenv ADVANCED_PROFILES 0)
multi=$(cenv PRINTER_MULTI_MATERIAL 0)
name=$(cenv PRINTER_DISPLAY_NAME)
placeholder=0
if [ -z "$machine" ]; then
  machine="MyKlipper 0.4 nozzle"
  placeholder=1
elif [ "$advanced" = 1 ] && [[ "$machine" =~ ^My(Klipper|Marlin|RRF|Repetier)\ 0\.4\ nozzle$ ]]; then
  placeholder=1
fi

stamp="orca=$(cenv ORCA_VERSION unknown)|machine=$machine|multi=$multi|name=$name|placeholder=$placeholder"
if [ -f "$PRINTER_DIR/.stamp" ] && [ "$(<"$PRINTER_DIR/.stamp")" = "$stamp" ] && [ -s "$PRINTER_DIR/printer.json" ]; then
  exit 0
fi

flags=()
[ "$multi" = 1 ] && flags+=(--multi-material)
[ -n "$name" ] && flags+=(--name "$name")
[ "$placeholder" = 1 ] && flags+=(--placeholder)

tmp=$(mktemp -d "$DATA_DIR/.printer.XXXXXX")
if [ "$placeholder" = 1 ]; then
  log "No printer set up yet: generic stand-in until your own printer preset is live (no quotes until then)"
else
  log "Generating slicing profiles for: $machine"
fi
if ! node /app/worker/dist/profile-gen.js generate "$machine" "$tmp" "${flags[@]}" >&2; then
  rm -rf "$tmp"
  die "Could not build slicing profiles for PRINTER_MACHINE=\"$machine\".
  It must be an exact OrcaSlicer machine preset name, e.g. \"Prusa MK4 0.4 nozzle\".
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
