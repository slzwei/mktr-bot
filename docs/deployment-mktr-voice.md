# Deployment: mktr-voice droplet

The production stack runs on one DigitalOcean droplet. This page records the facts an operator needs and the defects found during the first live call on 11 Sep 2026. Secrets live only in the protected env file on the host.

## Host

| Item | Value |
| --- | --- |
| Droplet | `mktr-voice`, DigitalOcean SGP1, Ubuntu 24.04, 2 GB RAM, 1 vCPU, 50 GB disk, 4 GB swap |
| Public IPv4 | `159.65.14.135` (whitelisted in Singtel CPaaS Security) |
| Operator UI | https://voice.mktr.sg (Caddy, Let's Encrypt) |
| SSH | `ssh mktr@159.65.14.135`, key only, root login disabled |
| Repo on host | `/srv/mktr-bot` (rsync from a developer machine; `.git` included) |
| Env file | `/etc/mktr/voice.env`, mode 600, owner mktr |
| TLS identity | `/etc/mktr/agent.pem` (self-signed, 2 years) |
| Singtel CA | `/etc/mktr/singtel-ca.pem` (Sectigo bundle from the CPaaS Overview page) |
| fs_cli profile | `/etc/mktr/fs_cli.conf` (ESL password, read only by mktr) |
| Firewall | ufw: 22, 80, 443 tcp+udp, 5061/tcp from 52.77.0.62 only, UDP 10000-10199 from 54.251.255.196-211 only |

The old `dnc-egress` droplet (159.89.201.126) hosts the PDPC DNC proxy, a RustDesk relay and the quantlab controller. It must not be touched.

## Everyday commands

Run from `/srv/mktr-bot` as `mktr` with `export COMPOSE_ENV_FILES=/etc/mktr/voice.env MKTR_DEPLOY_ENV=/etc/mktr/voice.env MKTR_FSCLI_PROFILE=/etc/mktr/fs_cli.conf`.

```bash
docker compose ps
curl -s https://voice.mktr.sg/api/health          # esl connected, gateway REGED in live mode
docker compose logs --follow --since 5m api media-worker
scripts/fs-cli-private.sh -x "sofia status gateway singtel"
scripts/fs-cli-private.sh -x "show channels as json"
```

Redeploy code after a change on the developer machine:

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude .server-dist --exclude storage --exclude test-results \
  --exclude '.env' --exclude '.env.*' ./ mktr@159.65.14.135:/srv/mktr-bot/
ssh mktr@159.65.14.135 'cd /srv/mktr-bot && export COMPOSE_ENV_FILES=/etc/mktr/voice.env && docker compose build api media-worker && docker compose up -d --force-recreate --wait api media-worker'
```

FreeSWITCH config lives in `telephony/freeswitch/conf` and is bind-mounted, so a template change only needs `docker compose up -d --no-deps --force-recreate --wait freeswitch`. A change to `telephony/freeswitch/Dockerfile` or `build-source.sh` needs `docker compose --profile live build freeswitch` (about 15 minutes on this host).

Switch back to the safe simulator by setting `MKTR_TELEPHONY_MODE=simulated` in the env file and recreating api and media-worker. Stop the gateway with `docker compose stop freeswitch`.

A fresh host is prepared with `scripts/bootstrap-host.sh` (run as root over SSH). It installs Docker, swap, the operator user, SSH hardening and the firewall rules above.

## Defects found on the real host

All three passed every fake-based test and only appeared against real FreeSWITCH and Deepgram. Each now has a regression test.

1. **Gateway never loaded.** `sip_profiles/external.xml` had `<gateways><X-PRE-PROCESS .../></gateways>` on one line. FreeSWITCH's preprocessor discards the rest of a line that carries an X-PRE-PROCESS tag, so both wrapper tags vanished and mod_sofia reported "Invalid Gateway!". Fix: the include sits on its own line. Guard: template scan in `server/freeswitch-config.test.ts`.
2. **Call hung up 40 ms after answer.** `avmd.conf.xml` had `report_status` 0. A successful `avmd <uuid> start` then writes nothing, FreeSWITCH replies `-ERR no reply` to the ESL api call, and the adapter failed the call. Fix: `report_status` 1. Guard: render assertion in the same test file.
3. **Listen step crashed on the first Deepgram marker.** The worker's schema required `channel` to be an object. Deepgram's UtteranceEnd and SpeechStarted messages send `channel` as an index array such as `[0, 1]`. Fix: accept both shapes. Guard: real message sequence in `media-worker/deepgram.test.ts`.

## First live call record

11 Sep 2026, call `4ff551b6-049b-4074-9bc9-79c5f6bcbbe1`, destination the operator's own mobile, caller ID +6562773211, flow Prospect qualification v4. Ringing 08:01:36 UTC, answered 08:01:42, greeting played, transcript "Yes." 1.8 s after speech ended, classified interested at 88 percent by rules, Interested clip played, Flow completed 08:02:00. No channel left on FreeSWITCH, capacity back to 0 of 1. A second call (`37e5c122`) repeated the same path.

Known tuning point: Deepgram endpointing is 750 ms, so a pause mid-sentence ends the utterance. Raise `endpointing` in `media-worker/deepgram.ts` if callers get cut off.
