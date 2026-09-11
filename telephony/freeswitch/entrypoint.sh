#!/bin/sh
set -eu
umask 077
node /opt/mktr/render-freeswitch.js
exec "$@"
