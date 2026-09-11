# Source build: no private SignalWire package repository or unverified image tag.
FROM node:22-bookworm-slim AS renderer
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY scripts/render-freeswitch.ts ./scripts/render-freeswitch.ts
RUN ./node_modules/.bin/tsc scripts/render-freeswitch.ts --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --outDir /renderer

FROM debian:bookworm-slim AS builder
ARG FREESWITCH_REF=ef32e205295e29f034f1453ad245ba5efb07b94a
ARG SOFIA_SIP_REF=ad36ac8f755308e8b87f98a505e83d4e408e5cc3
ARG SPANDSP_REF=8f1e1646bdec99eac5fd2cd92c35563f736b9b89
ARG AUDIO_STREAM_REF=5eb685ed9b179ce259946307a58cb6d65eadf783
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake build-essential ca-certificates cmake git libtool libtool-bin pkg-config \
    libcurl4-openssl-dev libedit-dev libevent-dev libjpeg-dev libopus-dev libpcre3-dev \
    libpng-dev libsndfile1-dev libspeex-dev libspeexdsp-dev libsqlite3-dev libssl-dev \
    libtiff-dev uuid-dev zlib1g-dev && rm -rf /var/lib/apt/lists/*
COPY telephony/freeswitch/build-source.sh /usr/local/bin/build-source
COPY telephony/freeswitch/modules.conf /build/modules.conf
RUN /usr/local/bin/build-source

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libcurl4 libedit2 libevent-2.1-7 libevent-openssl-2.1-7 libjpeg62-turbo \
    libopus0 libpcre3 libpng16-16 libsndfile1 libspeex1 libspeexdsp1 libsqlite3-0 libssl3 \
    libtiff6 libuuid1 openssl zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/ /usr/local/
COPY --from=builder /etc/ld.so.conf.d/mktr-freeswitch.conf /etc/ld.so.conf.d/mktr-freeswitch.conf
COPY --from=renderer /renderer/render-freeswitch.js /opt/mktr/render-freeswitch.js
COPY telephony/freeswitch/conf /opt/mktr/freeswitch-conf
COPY telephony/freeswitch/entrypoint.sh /usr/local/bin/mktr-freeswitch
RUN ldconfig && \
    ldd /usr/local/freeswitch/bin/freeswitch /usr/local/freeswitch/mod/*.so > /tmp/linked-libraries && \
    ! grep -q 'not found' /tmp/linked-libraries && \
    rm /tmp/linked-libraries && \
    mkdir -p /etc/freeswitch /var/lib/freeswitch/db /var/lib/freeswitch/recordings/mktr /var/log/freeswitch /run/freeswitch && \
    chown -R node:node /etc/freeswitch /var/lib/freeswitch /var/log/freeswitch /run/freeswitch
ENV PATH="/usr/local/freeswitch/bin:${PATH}" \
    MKTR_FREESWITCH_TEMPLATE_DIR=/opt/mktr/freeswitch-conf \
    MKTR_FREESWITCH_RENDER_DIR=/etc/freeswitch
USER node
EXPOSE 5061/tcp 10000-10199/udp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/mktr-freeswitch"]
CMD ["freeswitch", "-nf", "-nonat", "-np", "-conf", "/etc/freeswitch", "-db", "/var/lib/freeswitch/db", "-log", "/var/log/freeswitch", "-run", "/run/freeswitch"]
