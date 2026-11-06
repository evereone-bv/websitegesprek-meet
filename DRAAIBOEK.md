# Draaiboek meetserver – neerzetten, bijwerken, uitval

Doel: binnen 30 minuten een werkende meetserver, bij Hetzner of elders. Er zijn geen geheimen nodig om hem neer
te zetten.

## A. Nieuwe server (Hetzner Cloud, of elke partij met Ubuntu 24.04)

1. Server aanmaken: Ubuntu 24.04, 2 vCPU / 4 GB (Hetzner CX23, of CAX11 op ARM), locatie Duitsland.
2. Bij "Cloud config" / "user data" de inhoud van `deploy/cloud-config.yaml` plakken. Geen SSH-sleutel nodig.
3. Firewall bij de provider: inkomend alleen TCP 80 en 443 (en ICMP). Uitgaand alles.
4. DNS (Hostnet): A-record `meet` → IPv4 van de server, TTL 300.
5. Na ca. 5 minuten: `https://meet.websitegesprek.nl/healthz` geeft `{"ok":true,...}`.
6. Openbare sleutel ophalen: `https://meet.websitegesprek.nl/v1/pubkey` en in rapportage vastzetten
   (Websitegesprek › Meetserver, of via de koppeling). Een nieuwe server heeft een nieuwe sleutel; rapportage
   weigert antwoorden tot die is vastgezet. Zo kan niemand zich als meetserver voordoen.
7. Proefmeting vanuit rapportage (evereone.nl, contactblok) en controleren dat er maten terugkomen.

Installatielog op de server: `/var/log/meet-install.log` (Hetzner-console › Console).

## B. Bijwerken

- Automatisch elke zondag 04:17: code uit GitHub, nieuwste Playwright-basis-image, herstart (`meet-update.timer`).
- Direct: in de console `systemctl start meet-update.service`.
- Beveiligingsupdates van Ubuntu gaan dagelijks automatisch (unattended-upgrades).

## C. Uitval van de provider

1. Stap A uitvoeren bij een andere partij (alles staat in GitHub).
2. Of tijdelijk op Google Cloud Run (regio europe-west4): bouw het Dockerfile, zet `MEET_SERVER_KEY_PEM` als geheime
   variabele (anders verandert de sleutel bij elke start) en `MEET_PUBLIC_BASE` op het Cloud Run-adres; zet het
   adres en de openbare sleutel in rapportage. Let op: daar geldt de firewall uit `deploy/firewall.sh` niet; gebruik
   dan Cloud Run zonder VPC-toegang (standaard), zodat er geen interne netwerken bereikbaar zijn.
3. Rapportage valt intussen terug op de controle in de plugin ("meten lukt nu niet").

## D. Alleen rapportage laten meten (optioneel)

Zet het uitgaande IP-adres van rapportage in `/etc/meet/rapportage-ip` en draai `bash /opt/meet/deploy/install.sh`.
Caddy weigert dan meetopdrachten van andere adressen (de handtekening blijft daarnaast altijd verplicht).

## E. Controle na wijzigingen

- `npm test` lokaal groen (16 tests).
- Na neerzetten: healthz, pubkey, proefmeting.
- Firewall controleren in de console: `iptables -S MEET-EGRESS` toont de DROP-regels voor interne netwerken.
