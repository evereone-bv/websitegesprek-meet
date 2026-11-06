# Meetserver Websitegesprek (meet.websitegesprek.nl)

Meet openbare pagina's van gekoppelde WordPress-sites op mobiel, tablet en desktop, in alle talen en langs de
cache, en geeft Claude maten en meldingen in tekst terug. Zo is de eerste poging bij een ontwerpwijziging meteen
goed. Voorstel en besluit: `docs/voorstellen/meetserver-2026-11-06.md` (besluit Raymond 6 nov 2026).

## Hoe het loopt

```
Claude (telefoon) → plugin op klantsite (evereone/page-measure)
  → rapportage.websitegesprek.nl (sitesleutel, pakket, dagmaximum, ondertekent opdracht)
    → meet.websitegesprek.nl (controleert handtekening, meet, ondertekent antwoord)
  ← maten + meldingen + link naar plaatje (15 min)
```

## Beveiliging in het kort

- **Ondertekening (Ed25519):** rapportage tekent elke opdracht met zijn eigen geheime sleutel; hier staat alleen
  de openbare sleutel (`config/clients.json`). De meetserver maakt bij de eerste start zijn eigen sleutelpaar
  (`/data/meet-ed25519.pem`) en tekent elk antwoord; rapportage zet die openbare sleutel vast (`GET /v1/pubkey`).
  Opdrachten zijn 60 seconden geldig en kunnen niet opnieuw worden afgespeeld (nonce).
- **Adressen (OWASP SSRF):** alleen https op de domeinen die rapportage meestuurt; de host moet naar openbare
  IP's wijzen en wordt in Chromium op dat IP vastgezet; doorverwijzingen naar andere domeinen worden afgebroken.
- **Firewall (`deploy/firewall.sh`):** de container kan alleen naar openbare adressen op poort 80/443 en DNS,
  nooit naar interne netwerken, 169.254.169.254 of de server zelf.
- **Alleen kijken:** geen POST, geen downloads, geen service workers, geen cookies van eerder, geen navigatie na
  het laden; klikken alleen op knoppen die iets openen.
- **Container:** gewone gebruiker (pwuser), Chromium-sandbox aan met het seccomp-profiel van Playwright
  (`deploy/seccomp_profile.json`, Apache 2.0, Microsoft), alle Linux-capabilities weg, grenzen aan geheugen en processen.
- **Niets bewaren:** geen toegangslog met IP-adressen (Caddy zonder log); app-log alleen domein, tijd, duur en
  resultaat (max. 3 × 10 MB, oudste eerst weg); plaatjes 15 minuten in het werkgeheugen.

## Lokaal testen

```
npm install            # of: koppel een bestaande Playwright 1.63.0 in node_modules
npm test               # 16 tests: adressen, handtekeningen, metingen (Puglia-gevallen), alleen-kijken
```

## Neerzetten (nieuwe server, ook bij uitval elders)

Zie `DRAAIBOEK.md`. Kort: Ubuntu 24.04, cloud-config uit `deploy/cloud-config.yaml` plakken, A-record
`meet.websitegesprek.nl` naar het nieuwe IP, en de nieuwe openbare sleutel in rapportage vastzetten.

## Code

De bron staat in `evereone-bv/websitegesprek` onder `server/meet.websitegesprek.nl`. Een kopie staat in de
openbare repository `evereone-bv/websitegesprek-meet`, zodat een server zonder inloggegevens kan bijwerken.
Er staan geen geheimen in deze code.
