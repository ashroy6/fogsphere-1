#!/usr/bin/env bash
set -euo pipefail

# Patch the example modules so they import THREE from a local relative file
# instead of the package name "three". This avoids needing an import map/bundler.

patch_one () {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found." >&2
    exit 1
  fi
  # Replace: import * as THREE from 'three';
  # With:    import * as THREE from './three.module.js';
  perl -0777 -pe "s@import\\s+\\*\\s+as\\s+THREE\\s+from\\s+['\\\"]three['\\\"];@import * as THREE from './three.module.js';@" -i "$f"
  echo "Patched $f"
}

patch_one OrbitControls.module.js
patch_one GLTFLoader.module.js

echo "Done. Reload your page (Ctrl+F5)."
