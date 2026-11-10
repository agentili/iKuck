# Prodotto e interfaccia

iKuck aiuta a scegliere cosa cucinare, gestendo ricette, dispensa e piano in un'app guest-first/offline, condivisibile tramite la casa quando l'utente ha una sessione verificata. Per specifiche visive usa `DESIGN.md` e i token effettivi nel frontend; non copiare palette e classi da una nota storica.

## Dove verificare il comportamento

- `frontend/src/App.tsx` definisce le route correnti; `frontend/src/components/layout/BottomNav.tsx` definisce la navigazione mobile. La precedente skill contiene **più mappe di navigazione incompatibili**: non usarle come specifica vigente.
- `/` è il punto d'ingresso Chef; `/cucina` ha il flusso separato di generazione AI. Una rinuncia alla chat Chef non equivale a rinunciare alla generazione di ricette AI. Prima di aggiungere un'interfaccia chat, verifica la decisione di prodotto più recente e il codice corrente.
- Le azioni visibili devono essere reali; non presentare controlli finti per voce, scanner, consenso o salvataggio. Mantieni la copia visibile all'utente in italiano e commenti/identificatori in inglese.
- Mantieni accessibili i percorsi guest, offline, casa e recupero dei conflitti quando modifichi navigazione o dati.

Vecchie decisioni contrastanti sui colori o sul layout (inclusi "solo tema scuro" e "otto temi selezionabili") non sono una base affidabile senza riscontro nel codice e nel piano approvato.
