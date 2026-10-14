---
id: 2026-04-29-livre-de-recettes              # AAAA-MM-JJ-slug, écrit une fois, jamais modifié (même si le dossier bouge)
nom: Prandia
type: application                             # application | outil | documentation | travail | affaire
statut: actif                                  # idee | actif | pause | termine | abandonne
pitch: Application personnelle de gestion culinaire (ingrédients, recettes, nutrition), en pivot vers une PWA web.
cree: 2026-04-29
maj: 2026-10-14                               # AAAA-MM-JJ, mis à jour par Claude Code en fin de session
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
Desktop PySide6/QML complet, conservé comme référence. Côté web, la PWA Prandia tourne sur Cloudflare Pages (https://prandia.pages.dev) avec API en Pages Function, D1 (21 migrations), sur le plan payant de Workers depuis le 2026-10-11 et R2 en juridiction UE, plus un Worker à part, `prandia-notifier`, qui porte l'horloge des notifications. Le projet a été renommé Prandia partout le 2026-10-09 ; l'ancien projet Pages, l'ancienne base et l'ancien bucket ont été supprimés le 2026-10-11. Le 2026-10-10 : corrections pour que l'app installée se comporte comme une application sur iPhone (caméra, barre d'état, rebond, sélection, ascenseur), ajout d'un repas et d'un ingrédient de recette par une bibliothèque en tuiles plein écran, recette servie en grammes au planning, et notifications : un panneau de réglage et sept rappels (péremption, seuil de stock, repas du soir, planifier la semaine, hydratation, pesée, bilan de la semaine), déployés mais pas encore essayés sur l'iPhone ; enfin la saisie d'un ingrédient en cru ou en cuit dans les recettes, puis au planning le 2026-10-11, avec l'import d'une recette depuis un lien (revue des ingrédients avant création), et une saisie plus rapide après un scan : date de péremption lue par l'iPhone ou touchée dans une rangée de jours, dernier prix payé proposé ; puis des lectures par Claude Haiku (date, prix, poids, étiquette de pesée, fiche produit, tableau nutritionnel, rayon automatique) le vrac pesé en caisse, complété par la photo du ticket avant de terminer les courses, la complétion des fiches par l'IA (rayon, poids unitaire, poids cuit, saison, avec les champs remplis encadrés jusqu'à l'enregistrement) l'estimation par l'IA des quantités d'une recette importée qui ne sont pas en poids, le poids d'une cuillère par ingrédient et la place habituelle de chaque produit au rangement ; enfin Savarin, la signature de l'IA, qui propose aussi des rayons nouveaux d'après la bibliothèque. L'application bureau est abandonnée depuis le 2026-10-11 : le site suffit sur ordinateur. Depuis le 2026-10-12, la base est sauvegardée chaque nuit dans R2, copie vérifiée par restauration, date de la dernière visible dans Profil. Le 2026-10-14, Savarin lit au chariot un article en rafale (deux ou trois photos lues d’un coup, en arrière-plan, plusieurs à la fois).

## Prochaine étape
Valider la carte du parcours (CARTE.drawio, version 1 en brouillon). Essayer en magasin la lecture en rafale par Savarin (2 ou 3 photos par article, lues en arrière-plan) et le rangement comme d’habitude ; puis l’étendre au frigo si elle plaît. Chantier validé le 2026-10-14 : cuisiner un plat (ingrédients réels, plat au frigo, apports figés) et en manger des parts au planning devenu personnel, puis Savarin à la cuisine. Phase 1 ("Je la cuisine") livrée le 2026-10-14, à essayer ; reste à prendre des parts du plat au planning, le planning personnel et la liste de courses qui distingue ce qu’on cuisine de ce qu’on mange. À faire ensuite, décidé le 2026-10-11 : les valeurs d'un aliment CIQUAL proche pour les fiches sans valeurs, lire moins la base (la sobriété reste une règle, plan payant ou non), retravailler les textes des notifications, retirer le code de l'application bureau (abandonnée : le site suffit sur ordinateur). Idées notées pour plus tard : un assistant conversationnel branché sur les données (proposer la semaine de repas, créer une recette sur simple demande, toujours à valider), avec un plafond quotidien par utilisateur et une estimation du coût avant de le construire ; Savarin en grand sur l'Accueil pour ouvrir cet assistant ; un écran de connexion plus accueillant (noté le 2026-10-12). En attente : renommer le dossier du projet.

## Utilisation
Desktop : double-cliquer run.bat (crée le venv, installe les dépendances, lance python -m app.main) ; base SQLite prandia.db à la racine, seed CIQUAL facultatif via python -m app.data.seeds.ciqual_loader. Web : npm install puis npm run dev:web (Vite sur le port 5173) ou npx wrangler pages dev après build (port 8787) ; la production se déploie par simple git push sur main.
