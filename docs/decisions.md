# Implementation decisions

- A2: Use one serialized, reconnecting ESL connection and never replay an interrupted command because repeating an originate can create a second billable channel. The protocol follows the [FreeSWITCH event socket reference](https://developer.signalwire.com/freeswitch/integration/event-socket/).
- A2: Reserve and store the provider UUID before origination, match events to that UUID, and tag every playback because provider events can precede command replies and duplicate playback notifications must not advance a later node.
- A2: Terminate the provider channel before releasing its logical slot; if hangup cannot be confirmed, retain the slot and expose the error so a reconnect or operator retry can reconcile it.
- Verification: Keep simulator processes and fake ESL/STT tests separate from operator trunk checks; Docker-dependent checks cannot run on this host until the operator installs Docker.
