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
- **Vóór/na de updates (sinds 0.2.0, `doel: "voor_na"`):** maximaal 3 pagina's op 390 en 1440 px, hele pagina tot
  2400 px hoog, cookiemelding verborgen, formulieren en bewegende delen (sliders, video, iframes) gemaskeerd. Het
  plaatje gaat alleen als base64 in het ondertekende antwoord terug; hier wordt niets bewaard (ook niet 15 minuten).
  De site bewaart het zelf en vergelijkt.

- **Volgcodes vóór akkoord (sinds 0.3.0, `doel: "volgcodes"`, besluit 53):** maximaal 3 pagina's op 1440 px, als
  nieuwe bezoeker (schone browser, geen cookies), nergens op klikken, ~5 seconden wachten na het laden. Per pagina:
  verzoeken naar bekende volgdiensten (Meta, Google Analytics/Ads/Tag Manager, DoubleClick, Hotjar, Clarity,
  LinkedIn, TikTok, Pinterest, Bing, Snapchat), cookies van die diensten (alleen naam en domein, nooit de waarde),
  Google Consent Mode en of er een zichtbare cookiemelding met akkoordknop is. Meetverzoeken (pixels, beacons)
  krijgen hier een lege 204 en gaan dus niet echt naar de volgdienst (geen nepbezoek in de statistieken van de
  klant); alleen de scripts zelf worden geladen. In de teststand worden volgdiensten nooit benaderd (nabootsing).
  Niets wordt bewaard.

## Lokaal testen

```
npm install            # of: koppel een bestaande Playwright 1.63.0 in node_modules
npm test               # 31 tests: adressen, handtekeningen, metingen (Puglia-gevallen), alleen-kijken, vóór/na,
                       # overlap naast elkaar, standaardknop, nadruk en knoptekst (0.2.0),
                       # volgcodes vóór akkoord: direct, eigen cookiemelding, Consent Mode, text/plain, GTM na akkoord (0.3.0)
```

## Neerzetten (nieuwe server, ook bij uitval elders)

Zie `DRAAIBOEK.md`. Kort: Ubuntu 24.04, cloud-config uit `deploy/cloud-config.yaml` plakken, A-record
`meet.websitegesprek.nl` naar het nieuwe IP, en de nieuwe openbare sleutel in rapportage vastzetten.

## Code

De bron staat in `evereone-bv/websitegesprek` onder `server/meet.websitegesprek.nl`. Een kopie staat in de
openbare repository `evereone-bv/websitegesprek-meet`, zodat een server zonder inloggegevens kan bijwerken.
Er staan geen geheimen in deze code.

## Bewaking van klantsites en eigen servers (sinds 0.5.0, besluiten 481 en 506)

1. **Wat:** elke 5 minuten de homepage, hooguit 3 eigen stylesheets en de inlogpagina van elke site op de ondertekende lijst van rapportage (uitgelogd, zonder cookies, user-agent `Websitegesprek-bewaking (+https://websitegesprek.nl)`), en onze eigen servers. Code: `src/bewaking.mjs`, tests: `test/bewaking.test.mjs`.
2. **Standaard uit.** Aan met `BEWAKING_AAN=1` in `/etc/meet/bewaking.env` (wordt door `meet.service` gelezen, geen geheimen):
   ```
   BEWAKING_AAN=1
   BEWAKING_RAPPORTAGE=https://rapportage.websitegesprek.nl
   BEWAKING_SMTP_HOST=smtp-relay.gmail.com
   BEWAKING_MAIL_VAN=bewaking@websitegesprek.nl
   BEWAKING_MAIL_AAN=<alarmadres van EVEReONE>
   ```
   Daarna `systemctl restart meet`. Welke sites bewaakt worden, bepaalt alleen rapportage (`evereone/bewaking`): testsite, eigen sites, proefgroep van hooguit 5 klantsites (24 uur), dan iedereen. **Terugdraaien zonder inloggen:** op rapportage `evereone/bewaking action=zet_stand stand=uit`; de meetserver krijgt dan een lege lijst.
3. **Mail bij uitval van onze servers** gaat via de SMTP-relay van Google Workspace, met verificatie op het vaste IP-adres van deze server (Admin-console › Apps › Google Workspace › Gmail › Routing › SMTP-relay: alleen dit IP-adres, alleen de afzender `BEWAKING_MAIL_VAN`, TLS verplicht). Er staat dus geen wachtwoord op de server. Een pushbericht komt van de externe bewaker (besluit 501), nooit van deze server.
4. **Sleutel (Review V2).** De bewaking tekent met dezelfde sleutel als de metingen, met een eigen prefix per doel (`wg-bewaking-vraag:v1`, `wg-bewaking-uitslag:v1`; rapportage antwoordt met `wg-bewaking-lijst:v1`). Een handtekening voor het ene doel geldt dus nooit voor het andere. **Vervangen of intrekken:**
   1. op de server: `docker exec meet rm /data/meet-ed25519.pem && systemctl restart meet` (op de reserve: nieuwe `MEET_SERVER_KEY_PEM` zetten en herstarten);
   2. de nieuwe openbare sleutel staat op `https://meet.websitegesprek.nl/v1/pubkey`;
   3. op rapportage: `evereone/meet-server action=pin` (goedkeuringslink). Vanaf dat moment weigert rapportage alles wat met de oude sleutel is getekend.
   Eén keer geoefend op de testsite vóór livegang (V2).
5. **Grenzen (V3–V5, V16):** 5 s per verzoek, 15 s per site, 240 s per ronde (rest = niet gemeten, één alarm), antwoorden afgekapt op 2 MB/1 MB, hooguit 3 doorverwijzingen binnen dezelfde site, adressen via `guard.mjs` met vastgezet IP-adres, gewone https-verzoeken buiten de meetrij (geen Playwright). De bewaking draait in de container op `meetnet` (br-meet), dus de firewall (`deploy/firewall.sh`) houdt ook 169.254.169.254 en interne netwerken tegen.
