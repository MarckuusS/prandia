---
id: 2026-04-29-livre-de-recettes              # AAAA-MM-JJ-slug, écrit une fois, jamais modifié (même si le dossier bouge)
nom: Prandia
type: application                             # application | outil | documentation | travail | affaire
statut: pause                                 # idee | actif | pause | termine | abandonne
pitch: Application personnelle de gestion culinaire (ingrédients, recettes, nutrition), en pivot vers une PWA web.
cree: 2026-04-29
maj: 2026-10-10                               # AAAA-MM-JJ, mis à jour par Claude Code en fin de session
tags: [perso, pyside6, pwa, cloudflare]
stack: Python 3.12 + PySide6 + QML, puis Cloudflare Pages et Workers
lancer: run.bat
depot: https://github.com/MarckuusS/prandia.git
site: https://prandia.pages.dev
---

# Prandia

## Objectif
Application personnelle de gestion culinaire pour un foyer : bibliothèque d'ingrédients avec valeurs nutritionnelles (CIQUAL 2025 de l'ANSES et OpenFoodFacts) et coûts, recettes avec calcul automatique des macros et du prix par portion, calendrier hebdomadaire des repas, liste et session de courses, frigo et cellier, historique des prix. Depuis le 2026-08-01, le projet pivote vers une PWA installable sur iPhone, adossée à Cloudflare (Pages, D1, R2), afin de synchroniser téléphone et bureau ; l'application desktop PySide6/QML reste la référence jusqu'à parité fonctionnelle puis sera retirée.

## État actuel
Desktop PySide6/QML complet, conservé comme référence. Côté web, la PWA Prandia (nom adopté le 2026-08-12) tourne sur Cloudflare Pages avec API en Pages Function, D1 (17 migrations) et R2 en juridiction UE ; les derniers travaux, du 2026-08-16, portent sur le profil et les objectifs nutritionnels, le frigo et cellier par lieu (Chez moi) et l'administration des comptes. Dépôt git de 115 commits, dernier le 2026-10-09. Le 2026-10-09, le projet a été renommé Prandia partout : code, documentation, données locales, dépôt GitHub, projet Pages (https://prandia.pages.dev), base D1 prandia et bucket R2 prandia-media. Les données de production ont été copiées dans la nouvelle base et vérifiées ligne à ligne ; l'ancien projet Pages, l'ancienne base et l'ancien bucket sont encore en place, en attendant la validation. Le 2026-10-10, la connexion au nouveau site est validée, et le scanner réutilise un seul flux caméra pour limiter les demandes d'autorisation d'iOS (non encore poussé ni testé sur iPhone).

## Prochaine étape
Pousser le flux caméra partagé et le tester sur iPhone. Ensuite, dans cet ordre : une sauvegarde automatique des données de D1, les notifications (Web Push sur l'app installée), puis les fonctionnalités de recettes encore absentes. En attente d'accord : supprimer l'ancien projet Pages, l'ancienne base D1 et l'ancien bucket R2 (irréversible) ; renommer le dossier du projet.

## Utilisation
Desktop : double-cliquer run.bat (crée le venv, installe les dépendances, lance python -m app.main) ; base SQLite prandia.db à la racine, seed CIQUAL facultatif via python -m app.data.seeds.ciqual_loader. Web : npm install puis npm run dev:web (Vite sur le port 5173) ou npx wrangler pages dev après build (port 8787) ; la production se déploie par simple git push sur main.
