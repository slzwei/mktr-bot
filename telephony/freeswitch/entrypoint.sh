#!/bin/sh
set -eu
umask 077
node /opt/mktr/scripts/render-freeswitch.js
exec "$@"
