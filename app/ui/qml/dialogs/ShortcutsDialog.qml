// Dialog de référence des raccourcis clavier (U1).
//
// Vraie fenêtre système (Window) — détachable, non-modale. Liste les
// raccourcis groupés par catégorie. Pour ajouter un raccourci, l'enregistrer
// dans la page concernée ET l'ajouter au modèle ci-dessous (cohérence visuelle).

import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtQuick.Layouts
import App
import "../components"

Window {
    id: root

    title: "Raccourcis clavier"
    width: 540
    height: 580
    minimumWidth: 420
    minimumHeight: 400
    color: Theme.colorBackground
    flags: Qt.Dialog | Qt.WindowCloseButtonHint | Qt.WindowTitleHint
    modality: Qt.NonModal

    function openCentered(parentWindow) {
        if (parentWindow) {
            x = parentWindow.x + (parentWindow.width - width) / 2
            y = parentWindow.y + (parentWindow.height - height) / 2
        }
        show()
        raise()
    }

    // Données : groupes de raccourcis. À tenir synchro avec les `Shortcut`
    // disposés dans Main.qml et dans chaque page.
    readonly property var shortcuts: [
        {
            "category": "Navigation",
            "items": [
                { "keys": "Ctrl+1",  "label": "Aller à l'onglet Ingrédients" },
                { "keys": "Ctrl+2",  "label": "Aller à l'onglet Recettes" },
                { "keys": "Ctrl+3",  "label": "Aller à l'onglet Calendrier" },
                { "keys": "Ctrl+4",  "label": "Aller à l'onglet Liste de courses" },
                { "keys": "Ctrl+5",  "label": "Aller à l'onglet Frigo / Cellier" },
                { "keys": "Ctrl+K",  "label": "Recherche unifiée (ingrédients / recettes / calendrier)" },
                { "keys": "Ctrl+/",  "label": "Afficher cette aide" },
                { "keys": "Échap",   "label": "Fermer le dialog ouvert" }
            ]
        },
        {
            "category": "Actions globales",
            "items": [
                { "keys": "Ctrl+N",  "label": "Créer (ingrédient ou recette selon l'onglet)" },
                { "keys": "Ctrl+S",  "label": "Enregistrer le formulaire en cours" },
                { "keys": "Suppr",   "label": "Retirer l'élément sélectionné" },
                { "keys": "Ctrl+F",  "label": "Focus sur la barre de recherche" }
            ]
        },
        {
            "category": "Calendrier",
            "items": [
                { "keys": "Ctrl+←",  "label": "Semaine précédente" },
                { "keys": "Ctrl+→",  "label": "Semaine suivante" },
                { "keys": "Ctrl+T",  "label": "Aller à la semaine courante (today)" }
            ]
        },
        {
            "category": "Affichage",
            "items": [
                { "keys": "Ctrl+Shift+D", "label": "Basculer mode clair / sombre" }
            ]
        },
        {
            "category": "Diagnostic",
            "items": [
                { "keys": "Menu Aide",   "label": "Ouvrir le dossier de logs (~/.prandia/logs/)" },
                { "keys": "PRANDIA_DEBUG=1", "label": "Activer DEBUG en variable d'env (relance requise)" }
            ]
        }
    ]

    ScrollView {
        anchors.fill: parent
        anchors.margins: Theme.spaceLg
        clip: true

        ColumnLayout {
            width: root.width - Theme.spaceLg * 3   // -3 = marges + scrollbar
            spacing: Theme.spaceLg

            Text {
                text: "Raccourcis clavier"
                color: Theme.colorText
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeXl
                font.weight: Theme.fontWeightSemiBold
            }

            Text {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                text: "Les raccourcis sont contextuels — Ctrl+N crée un nouvel "
                      + "ingrédient sur l'onglet Ingrédients, une nouvelle recette "
                      + "sur l'onglet Recettes."
                color: Theme.colorTextSecondary
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSm
            }

            Repeater {
                model: root.shortcuts

                delegate: ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spaceXs

                    Text {
                        text: modelData.category.toUpperCase()
                        color: Theme.colorPrimary
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeXs
                        font.weight: Theme.fontWeightSemiBold
                        font.letterSpacing: 0.8
                    }

                    Repeater {
                        model: modelData.items
                        delegate: RowLayout {
                            Layout.fillWidth: true
                            spacing: Theme.spaceMd

                            // "Touche" : keycap stylé
                            Rectangle {
                                Layout.preferredWidth: 130
                                Layout.preferredHeight: 24
                                color: Theme.colorSurfaceHover
                                radius: Theme.radiusSm
                                border.width: 1
                                border.color: Theme.colorBorder
                                Text {
                                    anchors.centerIn: parent
                                    text: modelData.keys
                                    color: Theme.colorText
                                    font.family: "Consolas, Monaco, monospace"
                                    font.pixelSize: Theme.fontSizeSm
                                    font.weight: Theme.fontWeightMedium
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                text: modelData.label
                                color: Theme.colorText
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSm
                                wrapMode: Text.WordWrap
                            }
                        }
                    }
                }
            }

            Item { Layout.fillHeight: true; Layout.preferredHeight: Theme.spaceLg }
        }
    }
}
