// Fenêtre principale. ApplicationWindow + TabBar + StackLayout (3 onglets).
// En Phase 1, les onglets sont des placeholders. Phase 3 les remplacera par
// IngredientsPage / RecipesPage / CalendarPage.

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window

import App
import "components"
import "pages"
import "dialogs"

ApplicationWindow {
    id: window
    visible: true
    width: 1280
    height: 800
    minimumWidth: 980
    minimumHeight: 600
    title: qsTr("Prandia")

    color: Theme.colorBackground

    // Plan v3 : alias exposé pour que les pages enfants (ShoppingPage notamment)
    // puissent ouvrir le dialog d'import même s'il vit en global ici dans Main.
    // QML scope-les `id`s par fichier-composant — un alias est nécessaire pour
    // traverser la frontière.
    property alias receiptImportDialog: receiptImportDialogInstance
    property alias lidlPlusSetupDialog: lidlPlusSetupDialogInstance
    property alias categoryPickerDialog: categoryPickerDialogInstance
    property alias ingredientFilterDialog: ingredientFilterDialogInstance

    // Phase 2 — Navigation cross-onglet : depuis Recettes, on peut cliquer sur
    // un ingrédient pour basculer sur l'onglet Ingrédients en pré-sélectionnant
    // celui-ci. Cette fonction expose le contrat à toutes les pages.
    function navigateToIngredient(ingredientId) {
        tabBar.currentIndex = 0
        if (ingredientsPageRef && ingredientId > 0) {
            Qt.callLater(function() {
                ingredientsPageRef._loadIngredient(ingredientId)
            })
        }
    }

    // ---- Menu ----
    menuBar: MenuBar {
        // Style des items de la barre (Fichier/Affichage/Navigation)
        delegate: MenuBarItem {
            id: mbi
            implicitHeight: 30
            leftPadding: Theme.spaceMd
            rightPadding: Theme.spaceMd

            contentItem: Text {
                // Le préfixe "&" de Qt désigne le raccourci Alt+lettre. On le convertit
                // en lettre soulignée via Theme.formatMnemonic + textFormat RichText.
                textFormat: Text.RichText
                text: Theme.formatMnemonic(mbi.text)
                color: !mbi.enabled
                       ? Theme.colorTextDisabled
                       : mbi.highlighted
                         ? Theme.colorPrimary
                         : Theme.colorText
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeMd
                font.weight: mbi.highlighted ? Theme.fontWeightMedium : Theme.fontWeightRegular
                verticalAlignment: Text.AlignVCenter
                horizontalAlignment: Text.AlignHCenter
                Behavior on color { ColorAnimation { duration: Theme.durationFast } }
            }
            background: Rectangle {
                color: mbi.highlighted ? Theme.colorSurfaceHover : Theme.colorTransparent
                radius: Theme.radiusSm
                Behavior on color { ColorAnimation { duration: Theme.durationFast } }
            }
        }

        background: Rectangle {
            color: Theme.colorSurface
            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                height: 1
                color: Theme.colorBorder
            }
        }

        AppMenu {
            title: qsTr("&Fichier")
            Action {
                text: qsTr("&Restaurer une sauvegarde…")
                onTriggered: restoreDialog.openCentered(window)
            }
            MenuSeparator { }
            // Plan v3 Phase 5 — entrée opt-in. Affiche un état dans le label
            // pour que l'utilisateur sache d'un coup d'œil si c'est activé.
            Action {
                text: {
                    if (typeof lidlPlusVM === "undefined" || !lidlPlusVM) return qsTr("Lidl Plus auto-fetch (expérimental)…")
                    if (!lidlPlusVM.isAvailable) return qsTr("Lidl Plus auto-fetch (lib manquante)…")
                    if (!lidlPlusVM.isConnected) return qsTr("Lidl Plus auto-fetch (non configuré)…")
                    return qsTr(lidlPlusVM.enabled
                                ? "Lidl Plus auto-fetch · ✓ activé"
                                : "Lidl Plus auto-fetch · désactivé")
                }
                onTriggered: lidlPlusSetupDialogInstance.openCentered(window)
            }
            MenuSeparator { }
            // Refonte UX — éditeur de rayons d'ingrédients
            Action {
                text: qsTr("&Paramètres → Rayons d'ingrédients…")
                onTriggered: settingsCategoriesDialog.openCentered(window)
            }
            MenuSeparator { }
            Action {
                text: qsTr("&Quitter")
                shortcut: StandardKey.Quit
                onTriggered: Qt.quit()
            }
        }

        AppMenu {
            title: qsTr("&Affichage")
            Action {
                text: Theme.darkMode ? qsTr("Mode &clair") : qsTr("Mode &sombre")
                shortcut: "Ctrl+Shift+D"
                onTriggered: Theme.darkMode = !Theme.darkMode
            }
            // Note : l'option "Afficher / Masquer les en-cas (calendrier)" a
            // été retirée. Les 5 slots du calendrier (matin / en-cas matin /
            // midi / en-cas après-midi / soir) sont maintenant affichés en
            // permanence, avec une scrollbar verticale si la fenêtre est
            // trop courte.
        }

        AppMenu {
            title: qsTr("&Navigation")
            Action {
                text: qsTr("&1. Ingrédients"); shortcut: "Ctrl+1"
                onTriggered: tabBar.currentIndex = 0
            }
            Action {
                text: qsTr("&2. Recettes"); shortcut: "Ctrl+2"
                onTriggered: tabBar.currentIndex = 1
            }
            Action {
                text: qsTr("&3. Calendrier"); shortcut: "Ctrl+3"
                onTriggered: tabBar.currentIndex = 2
            }
            Action {
                text: qsTr("&4. Liste de courses"); shortcut: "Ctrl+4"
                onTriggered: tabBar.currentIndex = 3
            }
            Action {
                text: qsTr("&5. Frigo / Cellier"); shortcut: "Ctrl+5"
                onTriggered: tabBar.currentIndex = 4
            }
        }

        AppMenu {
            title: qsTr("&Aide")
            Action {
                text: qsTr("&Raccourcis clavier")
                shortcut: "Ctrl+/"
                onTriggered: shortcutsDialog.openCentered(window)
            }
            MenuSeparator { }
            Action {
                text: qsTr("Ouvrir le dossier de &logs")
                onTriggered: {
                    if (typeof logDirPath !== "undefined" && logDirPath) {
                        Qt.openUrlExternally("file:///" + logDirPath.replace(/\\/g, "/"))
                    }
                }
            }
        }
    }

    // ---- Layout : barre d'onglets + zone de contenu ----
    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        TabBar {
            id: tabBar
            Layout.fillWidth: true

            background: Rectangle {
                color: Theme.colorSurface
                Rectangle {
                    anchors.bottom: parent.bottom
                    anchors.left: parent.left
                    anchors.right: parent.right
                    height: 1
                    color: Theme.colorBorder
                }
            }

            AppTabButton { text: qsTr("Ingrédients");      width: 160 }
            AppTabButton { text: qsTr("Recettes");         width: 160 }
            AppTabButton { text: qsTr("Calendrier");       width: 160 }
            AppTabButton { text: qsTr("Liste de courses"); width: 180 }
            AppTabButton { text: qsTr("Frigo / Cellier");  width: 180 }
        }

        // ---- Zone de contenu : 3 pages empilées avec fade au changement d'onglet ----
        // On garde un StackLayout (préserve l'état de chaque page : sélection, scroll,
        // formulaire en cours d'édition) mais on anime l'opacité au changement
        // d'index pour un effet plus doux qu'un switch instantané.
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            StackLayout {
                id: pages
                anchors.fill: parent
                currentIndex: tabBar.currentIndex

                // Animation : opacity -> 0.55 puis -> 1 quand currentIndex change.
                // L'effet est subtil (250 ms) — pas de slide pour ne pas désorienter
                // l'utilisateur, juste un "blink" léger qui signale le changement.
                onCurrentIndexChanged: tabFade.restart()

                SequentialAnimation {
                    id: tabFade
                    NumberAnimation {
                        target: pages; property: "opacity"
                        from: 0.55; to: 1.0
                        duration: Theme.durationNormal
                        easing.type: Easing.OutCubic
                    }
                }

                IngredientsPage { id: ingredientsPageRef }
                RecipesPage {}
                CalendarPage { id: calendarPageRef }
                ShoppingPage {}
                PantryPage {}
            }
        }

        // ---- Status bar (F10 : indicateur OFF online/offline) ----
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 22
            color: Theme.colorSurface
            Rectangle {
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.right: parent.right
                height: 1
                color: Theme.colorBorder
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: Theme.spaceMd
                anchors.rightMargin: Theme.spaceMd
                spacing: Theme.spaceSm

                // Plan v3 Phase 2 — badge "tickets en attente". Apparaît dès
                // qu'au moins un fichier ticket est dans le sous-dossier de
                // tampon (au boot ou détecté en live par le watcher).
                Rectangle {
                    visible: typeof receiptImportVM !== "undefined"
                             && receiptImportVM
                             && receiptImportVM.pendingFileCount > 0
                    Layout.preferredHeight: 18
                    Layout.preferredWidth: receiptBadgeText.implicitWidth + Theme.spaceMd * 2
                    radius: Theme.radiusSm
                    color: Qt.alpha(Theme.colorPrimary, 0.18)
                    border.width: 1
                    border.color: Theme.colorPrimary

                    Text {
                        id: receiptBadgeText
                        anchors.centerIn: parent
                        text: "📥 " + (receiptImportVM ? receiptImportVM.pendingFileCount : 0)
                              + " ticket" + (receiptImportVM && receiptImportVM.pendingFileCount > 1 ? "s" : "")
                              + " en attente"
                        color: Theme.colorPrimary
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeXs
                        font.weight: Theme.fontWeightSemiBold
                    }

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        ToolTip.visible: containsMouse
                        ToolTip.text: "Cliquer pour importer le prochain ticket en attente"
                        ToolTip.delay: 400
                        onClicked: {
                            // Charge le plus ancien ticket en attente dans le VM,
                            // puis ouvre le dialog global directement sur ce ticket.
                            const path = receiptImportVM.loadNextPending()
                            if (path) {
                                receiptImportDialogInstance.openForPending(window)
                            }
                        }
                    }
                }

                // Plan v3 Phase 5 — badge spécifique pour les tickets Lidl
                // ramenés par l'auto-fetch API. Distinct du badge fichiers
                // (icône / couleur différentes pour ne pas confondre).
                Rectangle {
                    visible: typeof lidlPlusVM !== "undefined"
                             && lidlPlusVM
                             && lidlPlusVM.pendingTicketCount > 0
                    Layout.preferredHeight: 18
                    Layout.preferredWidth: lidlBadgeText.implicitWidth + Theme.spaceMd * 2
                    radius: Theme.radiusSm
                    color: Qt.alpha(Theme.colorAccent, 0.18)
                    border.width: 1
                    border.color: Theme.colorAccent

                    Text {
                        id: lidlBadgeText
                        anchors.centerIn: parent
                        text: "🛒 Lidl · " + (lidlPlusVM ? lidlPlusVM.pendingTicketCount : 0)
                              + " ticket" + (lidlPlusVM && lidlPlusVM.pendingTicketCount > 1 ? "s" : "")
                        color: Theme.colorAccent
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeXs
                        font.weight: Theme.fontWeightSemiBold
                    }

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        ToolTip.visible: containsMouse
                        ToolTip.text: "Cliquer pour importer le prochain ticket Lidl"
                        ToolTip.delay: 400
                        onClicked: {
                            const ids = lidlPlusVM.pendingTicketIds()
                            if (ids.length === 0) return
                            const ticketId = ids[0]
                            const detail = lidlPlusVM.fetchTicketDetailAsDict(ticketId)
                            if (detail && detail.id) {
                                if (receiptImportVM.loadFromLidlJson(detail)) {
                                    receiptImportDialogInstance.openForPending(window)
                                    lidlPlusVM.removePendingTicketId(ticketId)
                                }
                            }
                        }
                    }
                }

                Item { Layout.fillWidth: true }   // push to right

                Rectangle {
                    width: 8
                    height: 8
                    radius: 4
                    color: (typeof networkVM !== "undefined" && networkVM && networkVM.online)
                           ? Theme.colorSuccess
                           : Theme.colorError
                    Behavior on color { ColorAnimation { duration: Theme.durationFast } }
                }
                Text {
                    text: (typeof networkVM !== "undefined" && networkVM && networkVM.online)
                          ? "OpenFoodFacts en ligne"
                          : "OpenFoodFacts indisponible"
                    color: Theme.colorTextSecondary
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs

                    ToolTip.visible: statusMouse.containsMouse
                    ToolTip.text: "Dernière vérification : "
                                + (typeof networkVM !== "undefined" && networkVM
                                   ? networkVM.lastCheckedHuman
                                   : "—")
                                + "\nClique pour re-vérifier maintenant."
                    ToolTip.delay: 400
                }
            }
            // MouseArea hors du RowLayout — couvre toute la status bar
            MouseArea {
                id: statusMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: if (typeof networkVM !== "undefined" && networkVM) networkVM.checkNow()
            }
        }
    }

    // ---- Composant interne : page de placeholder pour Phase 1 ----
    component PagePlaceholder: Rectangle {
        property string title: ""
        property string subtitle: ""

        color: Theme.colorBackground

        ColumnLayout {
            anchors.centerIn: parent
            spacing: Theme.spaceLg
            width: 520

            Text {
                Layout.alignment: Qt.AlignHCenter
                text: title
                color: Theme.colorText
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeTitle
                font.weight: Theme.fontWeightSemiBold
            }

            Text {
                Layout.alignment: Qt.AlignHCenter
                Layout.fillWidth: true
                text: subtitle
                color: Theme.colorTextSecondary
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeMd
                wrapMode: Text.WordWrap
                horizontalAlignment: Text.AlignHCenter
            }

            // Vitrine rapide des composants pour vérifier visuellement Phase 1
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: showcase.implicitHeight + Theme.spaceXl * 2
                color: Theme.colorSurface
                radius: Theme.radiusLg
                border.width: 1
                border.color: Theme.colorBorder

                ColumnLayout {
                    id: showcase
                    anchors.fill: parent
                    anchors.margins: Theme.spaceXl
                    spacing: Theme.spaceMd

                    Text {
                        text: qsTr("Vitrine des composants Theme :")
                        color: Theme.colorTextSecondary
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSm
                        font.weight: Theme.fontWeightMedium
                    }

                    RowLayout {
                        spacing: Theme.spaceSm
                        AppButton { text: qsTr("Primary");   variant: "primary" }
                        AppButton { text: qsTr("Secondary"); variant: "secondary" }
                        AppButton { text: qsTr("Ghost");     variant: "ghost" }
                    }

                    AppTextField {
                        Layout.fillWidth: true
                        placeholderText: qsTr("Tape ici pour tester le focus glow…")
                    }

                    RowLayout {
                        spacing: Theme.spaceMd
                        AppComboBox {
                            model: ["g", "kg", "ml", "L", "c. à café"]
                            Layout.preferredWidth: 140
                        }
                        AppCheckBox {
                            text: qsTr("Coche-moi")
                        }
                        AppSpinBox {
                            realValue: 12.5
                            decimals: 1
                            realFrom: 0.0
                            realTo: 1000.0
                            realStep: 0.5
                        }
                    }
                }
            }
        }
    }

    // ============================================================ Dialogues globaux

    RestoreBackupDialog {
        id: restoreDialog
    }

    ShortcutsDialog {
        id: shortcutsDialog
    }

    // B6 — Recherche unifiée Ctrl+K
    UnifiedSearchDialog {
        id: unifiedSearch
        onItemActivated: function(kind, payload) {
            if (kind === "ingredient") {
                tabBar.currentIndex = 0   // Ingrédients
            } else if (kind === "recipe") {
                tabBar.currentIndex = 1   // Recettes
                if (payload && payload.id > 0) recipeEditorVM.loadById(payload.id)
            } else if (kind === "meal_entry") {
                tabBar.currentIndex = 2   // Calendrier
                if (payload && payload.isoWeek) calendarVM.setIsoWeek(payload.isoWeek)
            }
        }
    }

    // Plan v3 — dialog d'import de ticket en GLOBAL (Main.qml plutôt que dans
    // ShoppingPage) pour qu'il soit accessible depuis :
    //   1. Le bouton "📥 Importer un ticket" sur ShoppingPage (file picker)
    //   2. Le badge "X tickets en attente" dans la status bar (auto-load
    //      d'un fichier détecté par le watcher).
    //   3. La notification de tickets Lidl prêts à importer (Phase 5).
    // Exposé via `window.receiptImportDialog` (property alias ci-dessus).
    ReceiptImportDialog {
        id: receiptImportDialogInstance
    }

    // Plan v3 Phase 5 — dialog de configuration Lidl Plus.
    LidlPlusSetupDialog {
        id: lidlPlusSetupDialogInstance
    }

    // Refonte UX Phase 5 — éditeur de catégories + popup picker
    SettingsCategoriesDialog {
        id: settingsCategoriesDialog
    }
    CategoryPickerDialog {
        id: categoryPickerDialogInstance
    }

    // Refonte UX — filtres avancés sur la bibliothèque d'ingrédients
    IngredientFilterDialog {
        id: ingredientFilterDialogInstance
    }

    // Phase 5 — quand le polling Lidl ramène de nouveaux tickets, on les
    // notifie via la status bar (réutilise le badge "tickets en attente").
    Connections {
        target: typeof lidlPlusVM !== "undefined" ? lidlPlusVM : null
        function onNew_tickets_pending(ticketIds) {
            // On ne charge pas tout d'un coup : l'utilisateur clique le badge
            // pour importer le prochain ticket. La liste vit dans le VM.
            console.log("Lidl Plus :", ticketIds.length, "nouveau(x) ticket(s) prêt(s)")
        }
    }

    Shortcut {
        sequence: "Ctrl+K"
        context: Qt.WindowShortcut
        onActivated: unifiedSearch.openCentered()
    }
}
