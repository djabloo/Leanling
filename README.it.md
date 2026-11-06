# Leanling

**Keep the child, skip the bloat.**  ·  [English](README.md)

Leanling crea e mantiene aggiornato un *figlio* snello dei programmi self-hosted. Il figlio contiene solo quello che usi davvero: niente moduli enterprise che senza licenza non funzionano, niente telemetria, e con le tue correzioni sempre applicate. A ogni aggiornamento Leanling scarica la versione ufficiale in una cartella provvisoria, la controlla, applica la *ricetta*, la prova in un container usa e getta e solo dopo la installa. La versione precedente resta pronta per tornare indietro e le immagini vecchie vengono tolte, così il disco della VPS non continua a crescere.

Leanling **non ridistribuisce** i programmi. Ognuno scarica la versione ufficiale sulla propria macchina e la ricetta viene applicata lì.

## Come funziona un aggiornamento

```
leanling update <ricetta>
  1. scarica la nuova versione ufficiale (immagine Docker o sorgente git)
  2. scanner: OSV-Scanner, GuardDog, Gitleaks (+ ClamAV sull'immagine, se attivo)
  3. revisione dell'agente: legge solo le novità e cerca segni di attacco
  4. applica la ricetta: opzioni scelte da te, patch al sorgente
  5. costruisce e prova il figlio su una porta libera, senza dati veri
  6. il figlio è "pronto": lo installi tu (o da solo, se lo hai scelto)
  7. dopo l'installazione: controllo, ritorno automatico alla versione di prima se non risponde, pulizia
```

L'agente (Claude Code con abbonamento o chiave API, oppure OpenCode) lavora solo quando serve:
- **revisione**: legge i commit nuovi o le note di rilascio e chiude con `VERDETTO: OK` o `VERDETTO: SOSPETTO`. Se è sospetto, l'aggiornamento si ferma;
- **patch**: se una patch non si applica più perché l'originale è cambiato, la rifà sulla nuova versione e la salva a parte, da controllare.

Senza agente Leanling funziona lo stesso. Se una patch non si applica, si ferma e te lo dice.

## Installazione

Servono Node.js 20+, Docker e git.

```bash
git clone https://github.com/djabloo/Leanling.git
cd leanling
npm link            # rende disponibile il comando `leanling`
leanling doctor     # cosa c'è e cosa manca
leanling dashboard  # http://127.0.0.1:7878
```

Scanner consigliati (facoltativi, Leanling segnala se mancano):

| Scanner | Cosa trova | Installazione |
|---|---|---|
| [OSV-Scanner](https://google.github.io/osv-scanner/) | dipendenze con vulnerabilità note | binario singolo |
| [GuardDog](https://github.com/DataDog/guarddog) | pacchetti npm/PyPI malevoli | `pipx install guarddog` |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | chiavi e password nel codice | binario singolo |
| [ClamAV](https://www.clamav.net/) | malware nei file dell'immagine finale | `apt install clamav` |

Nessuno scanner dà garanzie al 100%: Leanling riduce il rischio, non lo azzera.

## Comandi

```
leanling list                      ricette e versione in uso
leanling add <url-git|immagine>    crea una ricetta nuova (--name, --no-agent)
leanling remove <ricetta>          toglie una ricetta creata da te
leanling update <ricetta>          prepara e prova il figlio (--force, --deploy)
leanling install <ricetta>         installa il figlio pronto
leanling rollback <ricetta>        torna alla versione precedente
leanling clean <ricetta>           toglie le immagini vecchie (--build-cache)
leanling agent claude [--api]      sceglie l'agente (none | claude | opencode)
leanling dashboard [--port 7878]   dashboard su 127.0.0.1
```

Per un aggiornamento automatico basta un cron, per esempio ogni notte:

```
0 4 * * *  leanling update uptime-kuma >> ~/.leanling/cron.log 2>&1
```

## Dashboard

Ascolta solo su `127.0.0.1`. Se la apri da fuori, mettila dietro un proxy con autenticazione oppure avviala con `LEANLING_TOKEN=un-segreto` e aprila con `?token=un-segreto`.

- **Selezioni**: cosa togliere dal figlio, gruppo per gruppo. Le novità trovate nell'ultima versione compaiono in evidenza: decidi tu se tenerle.
- **Contenitore**: nome, porte, volumi, limite di memoria, variabili in più, installazione automatica, pubblicazione dell'immagine.
- **Attività**: passaggi, scanner, revisione dell'agente e registro in diretta, più lo storico.
- **Impostazioni**: agente, accesso (abbonamento o chiave API), modello, scanner, versioni da tenere.

Impostazioni e stato stanno in `~/.leanling` (oppure in `$LEANLING_HOME`). La chiave API è salvata con permessi `600`.

## Aggiungere un programma

Dalla dashboard (**+ Aggiungi programma**) o da terminale:

```bash
leanling add https://github.com/autore/progetto     # build dal sorgente (serve un Dockerfile)
leanling add autore/immagine:tag                    # immagine Docker ufficiale
```

Leanling poi:
1. riconosce il tipo di ricetta;
2. legge porta, controllo di salute e volumi dal Dockerfile o dall'immagine;
3. salva una ricetta di base in `~/.leanling/recipes/<nome>`.

Se c'è un agente, legge anche il sorgente e propone una bozza. Ogni proposta resta **spenta** finché non la scegli tu.
- **Opzioni**: solo interruttori ufficiali (variabili d'ambiente) per telemetria, funzioni a pagamento o legate al cloud del produttore e banner promozionali. Le opzioni non ben formate vengono scartate.
- **Patch**: modifiche al Dockerfile (immagine più leggera, layer duplicati, permessi). Una patch viene tenuta solo se si applica davvero al sorgente.
- **Note**: licenza, limiti, cosa è stato lasciato fuori e perché.

Se non c'è niente da togliere, l'agente lo dice invece di inventare opzioni.

Le tue ricette restano sulla tua macchina: la repo di Leanling contiene solo il motore e un esempio.

## Esempio incluso

| Ricetta | Tipo | Cosa mostra |
|---|---|---|
| `uptime-kuma` | immagine ufficiale + profilo | il formato delle ricette: versione, un'opzione, test HTTP, valori del contenitore |

## Scrivere una ricetta

`leanling add` scrive la ricetta per te; puoi anche scriverla o modificarla a mano. Una ricetta è una cartella `~/.leanling/recipes/<nome>/` con un `recipe.json`:

- `type: "image"`: parte da un'immagine ufficiale (`image`, `tag`). Le `options` diventano variabili d'ambiente: `env` per i valori singoli, `list` per le liste separate da virgola. `discover` può leggere dall'immagine l'elenco di ciò che esiste, così le novità si vedono subito;
- `type: "build"`: parte da un repo git (`repo`, `ref`) e applica le `patches` (file `.patch` con un `intent` in parole semplici, che serve all'agente per rifarle). `maxSizeMB` ferma l'aggiornamento se l'immagine torna a pesare troppo;
- `test`: porta interna e controlli HTTP (`status`, `json`, `contains`) da superare prima dell'installazione;
- `container`: valori predefiniti per il container installato, modificabili dalla dashboard.

Regole per le ricette:
- non togliere né modificare file di licenza, avvisi di copyright o codice sotto licenze commerciali (spesso in cartelle o file chiamati `ee`, `enterprise` o `premium`): quello che è a pagamento si **spegne**, non si sblocca;
- rispettare la licenza di ogni programma: alcune licenze "source-available" permettono solo l'uso interno, non la rivendita come servizio.

## Licenza

MIT. Ogni programma gestito da una ricetta resta sotto la propria licenza.

---

Realizzato con [AgiCloud](https://agicloud.dev) e Claude Code, per l'amore delle VPS leggere e in salute.
