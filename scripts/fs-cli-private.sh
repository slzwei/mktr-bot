#!/usr/bin/env bash
set -euo pipefail

# Operator diagnostics only. --dry-run never reads credentials or invokes Docker.
mktr_fscli_dry=false
if [[ "${1:-}" == --dry-run ]]; then
  mktr_fscli_dry=true
  shift
fi
mktr_fscli_command=()
if [[ $# == 0 ]]; then
  mktr_fscli_command=(-l info)
elif [[ $# == 2 && $1 == -x ]]; then
  case "$2" in
    'sofia status gateway singtel'|'sofia status profile external'|'module_exists mod_audio_stream'|'module_exists mod_avmd'|'show channels as json') ;;
    *)
      mktr_fscli_uuid='[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}'
      if [[ ! "$2" =~ ^uuid_exists\ $mktr_fscli_uuid$ &&
            ! "$2" =~ ^uuid_kill\ $mktr_fscli_uuid\ NORMAL_CLEARING$ &&
            ! "$2" =~ ^uuid_getvar\ $mktr_fscli_uuid\ (read_codec|write_codec|rtp_secure_media|rtp_has_crypto)$ ]]; then
        echo 'Only the documented status, media-variable and single-UUID termination commands are accepted.' >&2
        exit 2
      fi
      ;;
  esac
  mktr_fscli_command=(-x "$2")
else
  echo 'Usage: scripts/fs-cli-private.sh [--dry-run] [-x "documented command"]' >&2
  exit 2
fi
mktr_fscli_profile=${MKTR_FSCLI_PROFILE:-/etc/mktr/fs_cli.conf}
mktr_fscli_environment=${MKTR_DEPLOY_ENV:-/etc/mktr/voice.env}
mktr_fscli_image=${MKTR_FREESWITCH_DIAGNOSTIC_IMAGE:-mktr-freeswitch:1.11.3}
if [[ "$mktr_fscli_profile" != /* || "$mktr_fscli_profile" == *,* || "$mktr_fscli_profile" == *$'\n'* ]]; then
  echo 'MKTR_FSCLI_PROFILE must be an absolute local file path without commas or newlines.' >&2
  exit 2
fi
if $mktr_fscli_dry; then
  mktr_fscli_container=DRY_API_CONTAINER_ID
else
  if [[ ! -f "$mktr_fscli_profile" || ! -r "$mktr_fscli_profile" ]]; then
    echo 'Create the private readable fs_cli profile described in the runbook first.' >&2
    exit 2
  fi
  mktr_fscli_container=$(docker compose --env-file "$mktr_fscli_environment" ps -q --status running api)
  if [[ -z "$mktr_fscli_container" ]]; then
    mktr_fscli_container=$(docker compose --env-file "$mktr_fscli_environment" ps -q --status running media-worker)
  fi
  if [[ ! "$mktr_fscli_container" =~ ^[a-f0-9]{12,64}$ ]]; then
    echo 'Exactly one running API or media-worker container is required for private ESL diagnostics.' >&2
    exit 2
  fi
fi
mktr_fscli_arguments=(run --rm --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges --read-only)
if [[ $# == 0 ]]; then mktr_fscli_arguments+=(-it); fi
mktr_fscli_arguments+=(--network "container:$mktr_fscli_container" --mount "type=bind,src=$mktr_fscli_profile,dst=/etc/fs_cli.conf,readonly" --entrypoint fs_cli "$mktr_fscli_image" -Q "${mktr_fscli_command[@]}")
if $mktr_fscli_dry; then
  printf 'DRY operator command only: docker'
  printf ' %q' "${mktr_fscli_arguments[@]}"
  printf '\n'
  exit 0
fi
exec docker "${mktr_fscli_arguments[@]}"
