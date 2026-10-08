#!/bin/bash

# Print the publish key for one stream, and the publish URL a broadcaster uses with it.
#
# A shell entry point because it reads this host's env file and sits beside the other operator
# scripts, but the derivation itself is `derive_publish_key` in `_lib.sh`, where a test can call it
# rather than keeping its own copy, and where the secret is kept out of any command line.

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

usage() {
  echo "Usage: publish-key.sh [flags] <app/stream>"
  echo
  # Every flag parse_profile_args consumes, because it consumes them whether or not they are
  # documented, and an undocumented one is worse than a rejected one: --portSlot=4 silently changed
  # the printed port, and the two-word spellings swallow the stream id and leave the usage text with
  # no hint of why.
  echo "  --profile=<name>      which .env.<name> and engines/*/.env.<name> to read"
  echo "  --portSlot=<0-99>     shifts every host port, so the printed URLs follow the deployment"
  echo "  --host=<target>       overrides the deploy target"
  echo "  --feed-owner=<hex>    override, unused here and consumed anyway"
  echo "  --feed-topic=<hex>    override, unused here and consumed anyway"
  echo "  --private-key=<hex>   override, unused here and consumed anyway"
  echo "  --stamp-id=<hex>      override, unused here and consumed anyway"
  echo "  --release-label=<label>, --release-commit=<commit>"
  echo "                        the release a deploy names, unused here and consumed anyway"
  echo
  echo "  Each flag also takes a two-word form, which consumes the next argument: write"
  echo "  --profile=live rather than --profile live unless the stream id follows both."
  echo
  echo "  Prints the publish key for one stream id, derived from PUBLISH_KEY_SECRET."
  echo "  The key is per stream: it proves nothing about any other, so it is safe to hand"
  echo "  to whoever broadcasts that stream and only that stream."
  exit 1
}

parse_profile_args "$@"
set -- "${REST_ARGS[@]}"

STREAM_ID="${1:-}"
[ -n "$STREAM_ID" ] || usage

# Mirrors STREAM_ID_SEGMENT and MAX_STREAM_ID_LENGTH in packages/stream-uploader/src/utils/streamId.ts.
#
# The one-slash check alone was not the same shape the service accepts, only the same shape it is
# spelled in, so this issued a real key and exited 0 for ids like `-weird/demo`, `video/my demo` and
# `video/a&b`. Every one is refused by parseAppStream as an unusable name, which from the outside
# looks exactly like an authentication failure, which is the confusion this check exists to prevent.
#
# `&` in particular also breaks the printed URL: it terminates the outer query, so the key is lost
# before OME sees it. The hand-rolled encoder below is complete for every id the service would accept
# and for none of the ones it would not, so screening here is what keeps that true.
readonly SEGMENT_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
readonly MAX_STREAM_ID_LENGTH=128

case "$STREAM_ID" in
  */*/*) echo "A stream id is <app>/<stream>, with one slash: got '$STREAM_ID'" >&2; exit 1 ;;
  */*) ;;
  *) echo "A stream id is <app>/<stream>: got '$STREAM_ID'" >&2; exit 1 ;;
esac

if [ "${#STREAM_ID}" -gt "$MAX_STREAM_ID_LENGTH" ]; then
  echo "A stream id is at most $MAX_STREAM_ID_LENGTH characters, which is what the service enforces" >&2
  exit 1
fi

for segment in "${STREAM_ID%%/*}" "${STREAM_ID#*/}"; do
  if [[ ! "$segment" =~ $SEGMENT_RE ]]; then
    echo "'$segment' is not a usable app or stream name: the service accepts letters, digits, dot," >&2
    echo "underscore and hyphen, beginning with a letter or digit. A key issued for this id would be" >&2
    echo "refused, and the refusal would look like an authentication failure." >&2
    exit 1
  fi
done

# Deliberately not `require_config` and `load_engine_envs`, which is what made this script unusable
# on a remote deploy target: those need `config.json` to decide which engines are enabled, and
# `deploy.sh` does not ship it. Nothing here needs that decision. The engine env files are read if
# they are present, purely to resolve the ports the URLs below print, and the compose fallbacks
# stand in when they are not.
#
# `require_jq` is absent for the same reason rather than by omission: with `get_target` gone, no
# function on this path runs jq. The guard the other operator scripts carry is not needed, and
# the dependency it guards is no longer here.
load_env
load_engine_envs_present
apply_port_slot

if [ -z "${PUBLISH_KEY_SECRET:-}" ]; then
  cat >&2 <<EOF
PUBLISH_KEY_SECRET is not set, so publisher authentication is off and there is no key to issue.
Every publisher can currently claim any stream name this deployment serves.

To turn it on, add a secret to $ENV_FILE and redeploy the stream-uploader:

  PUBLISH_KEY_SECRET=\$(openssl rand -hex 32)

Doing so refuses every publisher that does not present a key, so issue the keys first.
EOF
  exit 1
fi

# Checked rather than trusted. `derive_publish_key` exits non-zero on a secret the service would
# reject, and printing an empty key with a zero status is the failure that hands an operator a
# `?key=` nobody can publish with while telling them it worked.
if ! KEY=$(derive_publish_key "$STREAM_ID"); then
  exit 1
fi
if [[ ! "$KEY" =~ ^[a-f0-9]{32}$ ]]; then
  echo "Derived a publish key that is not 32 hex characters, refusing to print it" >&2
  exit 1
fi

APP="${STREAM_ID%%/*}"
STREAM="${STREAM_ID#*/}"

# SRS's SRT line, in the shape the admin's OBS panel hands a broadcaster (`buildSrtPublishUrl` and
# `buildObsSrtServer` in packages/contracts/src/ingest.ts). The key rides inside the `r=` value, which
# is where SRS reads a query from, and OBS takes the whole line as its Server with Stream Key empty.
SRS_SRT_SERVER="srt://<host>:${SRS_SRT_PORT:-10080}?streamid=#!::r=$APP/$STREAM?key=$KEY,m=publish"

# ⛔ The SRT passphrase is never printed. The one secret this script prints is the per-stream key,
# which is safe to hand to that stream's broadcaster, and the passphrase is one value for every
# stream on the listener. So the line carries a placeholder and the note names the file the value
# lives in. The value is read only to choose where OBS takes it, the same choice `buildObsSrtServer`
# makes: OBS ends a Server line value at `&`, turns `+` into a space and decodes nothing, so a
# passphrase with any other character goes in its Use authentication Password instead.
readonly SERVER_LINE_SAFE_PASSPHRASE='^[A-Za-z0-9._~-]+$'
SRS_ENV_FILE="$(engine_env_file "$SVC_SRS")"
SRS_ENV_NAME="${SRS_ENV_FILE#"$ROOT_DIR"/}"

print_srs_srt() {
  if [ -z "${SRT_PASSPHRASE:-}" ]; then
    echo "SRS  (SRT):  $SRS_SRT_SERVER"
    if [ -f "$SRS_ENV_FILE" ]; then
      echo "             (SRT_PASSPHRASE in $SRS_ENV_NAME is empty, so this SRT link is not encrypted)"
    else
      echo "             ($SRS_ENV_NAME is not on this machine, so whether SRS asks for a passphrase is"
      echo "              unknown here. If its SRT_PASSPHRASE is set, add &passphrase= and that value)"
    fi
  elif [[ "$SRT_PASSPHRASE" =~ $SERVER_LINE_SAFE_PASSPHRASE ]]; then
    echo "SRS  (SRT):  $SRS_SRT_SERVER&passphrase=<SRT_PASSPHRASE>"
    echo "             (the passphrase is not printed: put SRT_PASSPHRASE from $SRS_ENV_NAME in its place)"
  else
    echo "SRS  (SRT):  $SRS_SRT_SERVER"
    echo "             (SRT_PASSPHRASE in $SRS_ENV_NAME has characters this line cannot carry. In OBS,"
    echo "              tick Use authentication, leave Username empty and paste the passphrase into Password)"
  fi
  echo "             (in OBS the whole line goes in Server, and Stream Key stays empty)"
}

# OME takes the whole publish URL as an SRT `streamid`, so the key sits inside a value that is itself
# inside a query. The inner `?` and `/` have to be percent-encoded or the publisher's own URL parser
# eats them: with the plain spelling ffmpeg sends a streamid OME cannot resolve. Encoded by hand
# rather than with a helper, because the alphabet here is fixed and known.
ENCODED_STREAMID="srt%3A%2F%2F<host>%2F$APP%2F$STREAM%3Fkey%3D$KEY"

echo "Stream:      $STREAM_ID"
echo "Publish key: $KEY"
echo
print_srs_srt
echo "SRS  (RTMP): rtmp://<host>:${SRS_RTMP_PORT:-1935}/$APP/$STREAM?key=$KEY"
echo "OME  (SRT):  srt://<host>:${OME_SRT_PORT:-10080}?streamid=$ENCODED_STREAMID"
echo "             (the streamid is percent-encoded on purpose: unencoded, the publisher's own URL"
echo "              parser splits on the inner ? and OME never sees the key)"
echo
echo "The key is derived from the stream id, so it authorises this stream and no other."
echo "Rotating PUBLISH_KEY_SECRET invalidates every key at once, which is the only revocation there is."
