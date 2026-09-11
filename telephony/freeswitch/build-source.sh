#!/bin/sh
set -eu

# Invoked only by docker build, never by the application or the render command.
fetch_source() {
  mktr_project="$1"
  mktr_revision="$2"
  mktr_directory="$3"
  git init "$mktr_directory"
  git -C "$mktr_directory" remote add origin "https://github.com/$mktr_project.git"
  git -C "$mktr_directory" fetch --depth 1 origin "$mktr_revision"
  git -C "$mktr_directory" checkout --detach FETCH_HEAD
  test "$(git -C "$mktr_directory" rev-parse HEAD)" = "$mktr_revision"
}

fetch_source freeswitch/sofia-sip "$SOFIA_SIP_REF" /build/sofia-sip
cd /build/sofia-sip
./bootstrap.sh
./configure --prefix=/usr/local --with-openssl --without-doxygen
make -j2
make install

fetch_source freeswitch/spandsp "$SPANDSP_REF" /build/spandsp
cd /build/spandsp
./bootstrap.sh
./configure --prefix=/usr/local
make -j2
make install
ldconfig

fetch_source signalwire/freeswitch "$FREESWITCH_REF" /build/freeswitch
cd /build/freeswitch
./bootstrap.sh -j
cp /build/modules.conf modules.conf
PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure --prefix=/usr/local/freeswitch \
  --disable-fhs --disable-libyuv --disable-libvpx --disable-core-odbc-support
make -j2
make install
printf '%s\n' /usr/local/lib /usr/local/freeswitch/lib > /etc/ld.so.conf.d/mktr-freeswitch.conf
ldconfig

fetch_source amigniter/mod_audio_stream "$AUDIO_STREAM_REF" /build/mod_audio_stream
git -C /build/mod_audio_stream submodule update --init --recursive --depth 1
PKG_CONFIG_PATH=/usr/local/freeswitch/lib/pkgconfig:/usr/local/lib/pkgconfig \
  cmake -S /build/mod_audio_stream -B /build/mod_audio_stream/build -DCMAKE_BUILD_TYPE=Release -DUSE_TLS=ON
cmake --build /build/mod_audio_stream/build -j2
cmake --install /build/mod_audio_stream/build
test -s /usr/local/freeswitch/mod/mod_audio_stream.so
test -s /usr/local/freeswitch/mod/mod_event_socket.so
# Runtime must use the MKTR overlay and cannot fall back to vanilla demo users.
rm -rf /usr/local/freeswitch/conf /usr/local/freeswitch/db /usr/local/freeswitch/log
