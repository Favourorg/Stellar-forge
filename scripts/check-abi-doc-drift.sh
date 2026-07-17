#!/usr/bin/env bash
set -euo pipefail

LIB_RS="contracts/token-factory/src/lib.rs"
ABI_MD="docs/contract-abi.md"
EXIT_CODE=0
TMP=$(mktemp)

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo ":: Checking contract ABI documentation drift..."

awk '/impl TokenFactory/,/^}/' "$LIB_RS" | grep -oP 'pub fn \K\w+' > "$TMP"

if [ ! -s "$TMP" ]; then
  echo "::error::Could not extract public functions from $LIB_RS"
  exit 1
fi

echo ":: Found public functions in lib.rs:"
cat "$TMP"

MISSING=""
while IFS= read -r fn_name; do
  if ! grep -q "$fn_name" "$ABI_MD"; then
    MISSING="$MISSING  - $fn_name\n"
    EXIT_CODE=1
  fi
done < "$TMP"

ERROR_VARIANTS=$(awk '/enum Error \{/,/\}/' "$LIB_RS" | grep -oP '^\s+\w+' | tr -d ' ')

echo ""
echo ":: Checking Error enum variants in ABI doc..."
for variant in $ERROR_VARIANTS; do
  if ! grep -q "$variant" "$ABI_MD"; then
    MISSING="$MISSING  - Error::$variant\n"
    EXIT_CODE=1
  fi
done

if [ -n "$MISSING" ]; then
  echo "::error::Missing from ${ABI_MD}:"
  echo -e "$MISSING"
  echo ""
  echo "Please update ${ABI_MD} with the missing entries."
else
  echo ":: All public functions and error variants are documented in ${ABI_MD}"
fi

exit $EXIT_CODE
