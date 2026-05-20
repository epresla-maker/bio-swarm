# Bio Swarm - Product Vision (HU)

## Alapkoncepcio

A Bio Swarm egy decentralizalt biomedical AI halozat, ahol az iPhone alkalmazas csak a felhasznaloi es node felulet, mig a valodi intelligencia es szamitas egy edge + cloud hibrid rendszerben tortenik.

A rendszer celja, hogy a sok felhasznaloi eszkoz szabad kapacitasat kutatasi pre-compute feladatokra hasznalja, a nehez modellezest pedig felhoben tartsa.

## Mit old meg

Hagyomanyos modell:
- draga, kozponti GPU infrastruktura
- magas kezdeti koltseg
- korlatozott horizontalis skala

Bio Swarm modell:
- distributed edge compute a telefonokon
- cloud orchestration + heavy AI layer
- kozossegi kapacitasra epulo, skalahato kutatasi infrastruktura

## Mukodesi modell

### 1) Edge reteg (telefon mint node)

A telefon csak kis, parhuzamosithato munkakat futtat:
- molekula pontozasi eloszures
- biologiai mintak pre-screening
- embedding generalas (vagy reszfolyamatok)
- kutatasi adatok feldolgozasa
- hipotezisek rangsorolasa

Node policy:
- tolton van
- Wi-Fi kapcsolat aktiv
- idle allapot
- felhasznaloi opt-in

### 2) Cloud reteg (koordinacio es nehez szamitas)

A felho feladata:
- node koordinacio
- task kiosztas es lease kezeles
- eredmenyek validalasa (quorum, outlier kezeles)
- vegso kovetkeztetesek aggregalasa
- nehez AI modellek es szimulaciok futtatasa

## Hosszabb tavu cel

Collective intelligence rendszer letrehozasa:
- biomedical AI swarm
- crowd-powered research network
- tobb szazezres vagy millios eszkozhalozat

A hipotetikus elony:
- nem minden szamitast kell centralizalt GPU farmon vegezni
- a mobil edge reteg nagy volumenben tud pre-screening es masszivan parhuzamos feladatokat vegrehajtani

## Miert kulonleges

A Bio Swarm nem egy egyszeru AI app, hanem:
- decentralizalt scientific compute infrastruktura
- AI agent jellegu elosztott halozat
- edge + cloud hibrid platform
- kozossegi kutatasi operacios modell

## Inspiracios iranyok

- Folding@home tipusu distributed compute
- modern AI agent architecture
- federated AI megkozelitesek
- biomedical kutatasi AI workflow-k

## Biztonsagi es tudomanyos korlatok (MVP)

- A node-ok nem megbizhatok, ezert quorum validacio szukseges.
- PII / azonositheto klinikai adat nem kerulhet edge feladatba.
- Az MVP nem automatikus orvosi dontest tamogat.
- Minden relevans output emberi felulvizsgalat alatt marad.

## Sikermerok (MVP -> Phase 1)

- Aktiv node-ok szama / nap
- Task completion rate
- Quorum convergence idok
- Rejected result ratio
- Cost per accepted compute unit
- Reproducibility score (azonos task, fuggetlen node-ok)

## Megvalositasi fazisok

### Fazis A - MVP stabilizalas
- in-memory queue megtartasa, API stabilizalas
- edge runtime megbizhatosagi javitasok
- alap telemetry pipeline

### Fazis B - Trust hardening
- alairt task envelope
- checksum + provenance metadata
- replay vedelem, lease timeout strategiak

### Fazis C - Scale alapok
- Redis streams / durable queue
- reputation model node szinten
- job prioritas, retry policy, dead-letter kezeles

### Fazis D - Kutatasi workflow
- reprodukalhatosagi gate-ek
- bias es quality check pipeline
- human-in-the-loop review folyamat

## Donto elv

Minden uj feature csak akkor kerulhet be, ha:
1. nem rontja a tudomanyos reprodukalhatosagot,
2. nem noveli a klinikai adatvedelmi kockazatot,
3. horizontalisan skalahato marad edge + cloud modellben.
