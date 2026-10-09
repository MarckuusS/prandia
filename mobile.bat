@echo off
setlocal enabledelayedexpansion

rem ===========================================================================
rem Ouvre l'application web en TELEPHONE, sur cette machine.
rem
rem Construit le site, applique les migrations locales, demarre le serveur, et
rem ouvre un navigateur reglé en iPhone avec l'ecran tactile ACTIF : le glisser,
rem le balayage et les cibles au doigt se comportent comme sur un telephone,
rem pas seulement la mise en page.
rem
rem IL N'Y A PAS D'ECRAN DE CONNEXION. Un serveur local sert a regarder des
rem ecrans, pas a garder un secret : sa base ne contient que des donnees
rem d'essai. L'ecran de connexion n'y protegeait rien, mais il pouvait tout
rem bloquer : un mot de passe choisi une fois puis oublie, ou dix tentatives
rem ratees, et la maquette n'ouvrait plus. Le contournement vit dans
rem `.dev.vars`, fichier que le deploiement ne lit jamais ; les deux verrous qui
rem l'interdisent en ligne sont decrits au-dessus de devUser(), dans
rem worker/src/auth.ts.
rem
rem    mobile.bat              -> entre directement dans l'application
rem    mobile.bat connexion    -> garde l'ecran de connexion, pour le tester
rem
rem Idempotent : relancable autant de fois qu'on veut. Ctrl+C dans la fenetre du
rem serveur arrete tout.
rem ===========================================================================

cd /d "%~dp0"

rem ---- Avec ou sans ecran de connexion -----------------------------------
set "AVEC_CONNEXION="
if /i "%~1"=="connexion" set "AVEC_CONNEXION=1"

rem ---- Les reglages, tous au meme endroit --------------------------------
set "PORT=8788"
set "CDP_PORT=9222"
set "CIBLE=http://localhost:%PORT%"

rem L'ETAT LOCAL VIT HORS DU PROJET, et ce n'est pas un gout de rangement.
rem Le chemin de ce depot contient une espace et un signe plus ; miniflare, qui
rem simule D1 et R2, n'arrive pas a y ouvrir ses fichiers SQLite et s'arrete sur
rem un SQLITE_CANTOPEN sans expliquer pourquoi. On l'installe donc ailleurs.
rem Pas dans %TEMP% non plus : Windows y fait le menage, et la base de
rem developpement disparaitrait sans prevenir.
set "ETAT=%LOCALAPPDATA%\Prandia\dev-state"

rem ---- 1. Node -----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto err_no_node

rem ---- 2. Dependances ----------------------------------------------------
if exist "node_modules\" goto build
echo [1/5] Installation des dependances (premiere fois, quelques minutes)...
call npm install
if errorlevel 1 goto err_install

:build
rem ---- 3. Construction du site ------------------------------------------
rem `wrangler pages dev` sert le DOSSIER CONSTRUIT, pas les sources : sans
rem cette etape, on regarderait la version precedente sans le savoir.
echo [2/5] Construction du site...
call npm --workspace web run build
if errorlevel 1 goto err_build

rem ---- 4. Migrations de la base locale ----------------------------------
rem LE MEME --persist-to QUE LE SERVEUR, sinon les migrations s'appliquent a une
rem base que personne ne lira. Le defaut s'est produit : l'ecran tombait en
rem panne en local avec une colonne manquante, alors que la production l'avait.
echo [3/5] Mise a jour de la base locale...
if not exist "%ETAT%" mkdir "%ETAT%"
call npx wrangler d1 migrations apply DB --local --persist-to "%ETAT%"
if errorlevel 1 goto err_migrate

rem ---- 4 bis. Le reglage local du serveur --------------------------------
rem
rem CE BLOC A REMPLACE LA CREATION D'UN COMPTE, et c'est le meme defaut qu'il
rem repare une bonne fois. Tout demarrait correctement, puis l'application
rem s'arretait sur son ecran de connexion : tantot "Aucun compte n'est
rem configuré sur ce serveur", tantot un mot de passe choisi au premier
rem lancement et oublie depuis, tantot dix tentatives ratees et un verrou de
rem quinze minutes. Trois facons differentes de ne pas pouvoir regarder ses
rem propres ecrans, pour proteger une base qui ne contient que des essais.
rem
rem Desormais le serveur local ouvre d'office, et le compte se cree tout seul
rem s'il n'y en a aucun. Plus de question au demarrage, donc plus de lanceur
rem fige a attendre une reponse que personne ne donne.
if defined AVEC_CONNEXION (
  echo [3 bis/5] Reglage local : ecran de connexion CONSERVE.
  node scripts\dev-vars.mjs --connexion
) else (
  echo [3 bis/5] Reglage local : connexion automatique.
  node scripts\dev-vars.mjs
)
if errorlevel 1 goto err_vars

rem Un compte n'est necessaire QUE si l'on a demande l'ecran de connexion :
rem sans lui, le serveur en cree un tout seul au premier appel.
if not defined AVEC_CONNEXION goto serveur
node scripts\dev-compte.mjs --persist-to="%ETAT%"
if errorlevel 1 goto err_compte

:serveur
rem ---- 4 ter. LE PORT, LIBERE AVANT TOUT ---------------------------------
rem
rem LE DEFAUT LE PLUS COUTEUX DE CE LANCEUR, parce qu'il ne ressemblait pas a
rem une panne. Un serveur d'un lancement precedent garde le port ; le nouveau
rem n'arrive pas a s'y attacher, mais l'ANCIEN, lui, repond parfaitement. La
rem sonde ci-dessous le voyait repondre, declarait le demarrage reussi, et le
rem navigateur s'ouvrait sur le site tel qu'il etait une heure plus tot.
rem
rem On corrigeait alors un ecran, on relancait, et rien ne changeait, sans le
rem moindre message d'erreur pour dire pourquoi. Mesure faite : deux serveurs
rem vivants en meme temps, celui de 15h26 servant encore la page pendant que
rem celui de 15h39 tournait a cote, inutile.
set "LIBERE="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
  echo       Un serveur tenait deja le port %PORT% ^(PID %%p^) : arret.
  taskkill /PID %%p /T /F >nul 2>nul
  set "LIBERE=1"
)
if defined LIBERE "%SystemRoot%\System32\ping.exe" -n 3 127.0.0.1 >nul

rem ---- 4 quater. Les bundles temporaires de wrangler ---------------------
rem
rem Wrangler ecrit un dossier `.wrangler\tmp\bundle-*` a chaque demarrage et ne
rem le reprend jamais. L'etat de la base vit ailleurs (voir ETAT plus haut),
rem donc ce dossier ne contient RIEN qui doive survivre : mesure faite, 255
rem bundles pour 68 Mo, et `.wrangler\state` entierement vide a cote.
rem
rem APRES l'arret du serveur, jamais avant : celui qui tourne encore tient son
rem propre bundle ouvert.
if exist ".wrangler\tmp\" rd /s /q ".wrangler\tmp" 2>nul

rem ---- 5. Le serveur, dans sa propre fenetre -----------------------------
rem Une fenetre a lui pour que ses journaux restent lisibles et qu'un Ctrl+C
rem l'arrete sans fermer celle-ci.
echo [4/5] Demarrage du serveur sur %CIBLE% ...
start "Prandia - serveur local" cmd /k npx wrangler pages dev web/dist --port %PORT% --persist-to "%ETAT%"

rem On attend qu'il reponde VRAIMENT. Lancer le navigateur trop tot ouvre une
rem page d'erreur, et c'est a cette page-la que l'emulation s'appliquerait.
rem
rem DEUX OUTILS DE WINDOWS, APPELES PAR LEUR CHEMIN, et chacun a coute un essai.
rem
rem `curl` pour sonder, parce qu'il demarre instantanement. PowerShell le fait
rem aussi bien mais met pres d'une seconde a se lancer, et l'ecrire sur
rem plusieurs lignes avec des accents circonflexes de continuation cassait la
rem commande sans rien dire : elle echouait alors a chaque tour, et le serveur
rem etait declare mort alors qu'il repondait.
rem
rem `ping` pour attendre, parce que `timeout` tombe sur celui de Git pour
rem Windows quand ses outils Unix sont dans le PATH, et que celui de Windows
rem refuse de tourner quand l'entree standard est redirigee. `ping` ne regarde
rem ni l'un ni l'autre : deux envois font environ une seconde.
echo       (attente du serveur, jusqu'a 60 secondes)
set /a essais=0
:attendre
set /a essais+=1
if %essais% gtr 60 goto err_serveur
"%SystemRoot%\System32\curl.exe" -s -o nul --max-time 2 "%CIBLE%"
if errorlevel 1 (
  "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
  goto attendre
)

rem ---- 6. Le navigateur --------------------------------------------------
set "NAVIGATEUR="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "NAVIGATEUR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined NAVIGATEUR if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "NAVIGATEUR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined NAVIGATEUR if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "NAVIGATEUR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined NAVIGATEUR if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "NAVIGATEUR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined NAVIGATEUR goto err_navigateur

rem UN PROFIL A PART, et deux raisons. La prise de debogage est refusee sur le
rem profil habituel, par securite : sans profil dedie, le pilotage echoue en
rem silence. Et cela evite d'ouvrir une session de test au milieu de ses
rem propres onglets.
set "PROFIL=%LOCALAPPDATA%\Prandia\mobile-profile"

rem LES FENETRES DU LANCEMENT PRECEDENT, FERMEES D'ABORD. Meme histoire que le
rem port quelques lignes plus haut : Chromium ne demarre qu'une instance par
rem profil, donc si une fenetre de test traine, la commande ci-dessous ne cree
rem aucun navigateur, elle demande a l'ancien d'ouvrir un onglet. Or la prise de
rem debogage appartient au navigateur, pas a l'onglet, et l'ancienne instance ne
rem l'a pas ouverte : l'emulation echouait alors sur "Not attached to an active
rem page". `mobile-view.mjs` savait deja nommer cette cause et demandait de
rem fermer les fenetres a la main ; c'est un geste que le lanceur peut faire.
rem Seul le profil de test est vise, jamais la navigation ordinaire.
node scripts\fermer-navigateur-test.mjs "%PROFIL%"

echo [5/5] Ouverture du navigateur en mode telephone...
start "" "%NAVIGATEUR%" ^
  --remote-debugging-port=%CDP_PORT% ^
  --user-data-dir="%PROFIL%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --new-window ^
  --window-size=440,940 ^
  "%CIBLE%"

rem La bascule en telephone. CE SCRIPT NE REND PAS LA MAIN, et c'est voulu :
rem les reglages d'emulation sont lies a la connexion de debogage, pas au
rem navigateur. Des qu'on se deconnecte, Chromium les annule et la page
rem redevient un ordinateur. Mesure : une premiere version envoyait les
rem commandes puis rendait la main, annoncait un succes, et ne changeait rien.
rem
rem Il occupe donc cette fenetre. Ctrl+C ici revient au mode ordinateur, Ctrl+C
rem dans l'autre fenetre arrete le serveur.
echo.
echo ==========================================================================
echo  L'application tourne sur %CIBLE%
echo.
echo  La fenetre ouverte se comporte comme un iPhone : glisser, balayer, et les
echo  cibles au doigt. Le survol n'existe pas, comme sur un vrai telephone.
echo.
if defined AVEC_CONNEXION (
  echo  L'ecran de connexion est actif, et le compte a ete verifie a l'etape
  echo  precedente : il a de quoi repondre.
) else (
  echo  Il n'y a pas d'ecran de connexion : le serveur local ouvre d'office.
  echo  Pour le tester quand meme, relance avec : mobile.bat connexion
)
echo ==========================================================================
echo.

node scripts\mobile-view.mjs
if errorlevel 1 goto err_emulation
goto end

rem ---- Erreurs, toujours expliquees --------------------------------------
:err_no_node
echo.
echo [erreur] Node introuvable. Installe Node 22 ou plus depuis https://nodejs.org/
goto fail

:err_install
echo.
echo [erreur] L'installation des dependances a echoue.
echo          Verifie ta connexion internet.
goto fail

:err_build
echo.
echo [erreur] La construction du site a echoue. Lis les messages au-dessus.
goto fail

:err_migrate
echo.
echo [erreur] Les migrations de la base locale ont echoue.
echo          Etat local : %ETAT%
echo          Si la base est abimee, supprime ce dossier et relance : il se
echo          recree vide, tu perds seulement les donnees de developpement.
goto fail

:err_vars
echo.
echo [erreur] Le fichier .dev.vars n'a pas pu etre ecrit a la racine du projet.
echo          Sans lui, le serveur local garde l'ecran de connexion et exige un
echo          compte. Verifie les droits d'ecriture sur :
echo             %CD%
goto fail

:err_compte
echo.
echo [erreur] Aucun compte n'a pu etre cree sur la base locale.
echo          Sans compte, l'ecran de connexion ne sert a rien : l'application
echo          repond "Aucun compte n'est configure sur ce serveur".
echo          Tu peux reessayer a la main :
echo             node scripts\dev-compte.mjs --persist-to="%ETAT%"
goto fail

:err_serveur
echo.
echo [erreur] Le serveur n'a pas repondu apres une minute.
echo          Regarde la fenetre "Prandia - serveur local" : elle porte la raison.
echo          Cause frequente : le port %PORT% est deja pris par un autre lancement.
goto fail

:err_navigateur
echo.
echo [erreur] Ni Chrome ni Edge n'ont ete trouves.
echo          L'emulation tactile passe par le protocole DevTools, que seuls les
echo          navigateurs Chromium exposent. Firefox et Safari ne conviennent pas.
goto fail

:err_emulation
echo.
echo [erreur] Le passage en mode telephone a echoue.
echo          Le site reste ouvert et utilisable, mais avec une souris.
echo          Tu peux basculer a la main : F12 puis Ctrl+Shift+M.
goto fail

:fail
pause
endlocal
exit /b 1

:end
endlocal
