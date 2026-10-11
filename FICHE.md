---
id: 2026-04-29-livre-de-recettes              # AAAA-MM-JJ-slug, écrit une fois, jamais modifié (même si le dossier bouge)
nom: Prandia
type: application                             # application | outil | documentation | travail | affaire
statut: actif                                  # idee | actif | pause | termine | abandonne
pitch: Application personnelle de gestion culinaire (ingrédients, recettes, nutrition), en pivot vers une PWA web.
cree: 2026-04-29
maj: 2026-10-11                               # AAAA-MM-JJ, mis à jour par Claude Code en fin de session
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
Desktop PySide6/QML complet, conservé comme référence. Côté web, la PWA Prandia tourne sur Cloudflare Pages (https://prandia.pages.dev) avec API en Pages Function, D1 (19 migrations) et R2 en juridiction UE, plus un Worker à part, `prandia-notifier`, qui porte l'horloge des notifications. Le projet a été renommé Prandia partout le 2026-10-09 ; l'ancien projet Pages, l'ancienne base et l'ancien bucket sont encore en place, en attendant la validation. Le 2026-10-10 : corrections pour que l'app installée se comporte comme une application sur iPhone (caméra, barre d'état, rebond, sélection, ascenseur), ajout d'un repas et d'un ingrédient de recette par une bibliothèque en tuiles plein écran, recette servie en grammes au planning, et notifications : un panneau de réglage et sept rappels (péremption, seuil de stock, repas du soir, planifier la semaine, hydratation, pesée, bilan de la semaine), déployés mais pas encore essayés sur l'iPhone ; enfin la saisie d'un ingrédient en cru ou en cuit dans les recettes, puis au planning le 2026-10-11, avec l'import d'une recette depuis un lien (revue des ingrédients avant création), et une saisie plus rapide après un scan : date de péremption lue par l'iPhone ou touchée dans une rangée de jours, dernier prix payé proposé ; puis des lectures par Claude Haiku (date, prix, poids, étiquette de pesée, fiche produit, tableau nutritionnel, rayon automatique) le vrac pesé en caisse, complété par la photo du ticket avant de terminer les courses, et la complétion des fiches par l'IA (rayon, poids cuit, saison).

## Prochaine étape
Lancer la complétion de la bibliothèque par l'IA et relire quelques fiches ; essayer en magasin les lectures par Claude (bouton Scanner, étiquette de pesée, lecture du ticket) et sur l'iPhone la saisie de la date par "Scanner le texte" (frigo, chariot, À ranger), l'import par lien, les notifications et la saisie en cuit (recettes et planning). Ensuite, une sauvegarde automatique des données de D1. En attente d'accord : supprimer l'ancien projet Pages, l'ancienne base D1 et l'ancien bucket R2 (irréversible) ; renommer le dossier du projet.

## Utilisation
Desktop : double-cliquer run.bat (crée le venv, installe les dépendances, lance python -m app.main) ; base SQLite prandia.db à la racine, seed CIQUAL facultatif via python -m app.data.seeds.ciqual_loader. Web : npm install puis npm run dev:web (Vite sur le port 5173) ou npx wrangler pages dev après build (port 8787) ; la production se déploie par simple git push sur main.
