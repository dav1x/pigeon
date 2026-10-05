import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

/** Add a round trash button beside the notification close (X) control. */
export function addPigeonTrashButton(message, notification) {
    const onDelete = notification?._pigeonOnDelete;
    if (!onDelete || message._pigeonTrashButton)
        return;

    const header = message._header;
    if (!header?.closeButton)
        return;

    const trashButton = new St.Button({
        style_class: 'message-close-button pigeon-trash-button',
        icon_name: 'user-trash-symbolic',
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
        can_focus: true,
        accessible_name: _('Delete'),
    });

    trashButton.connect('clicked', () => {
        onDelete();
    });

    // Sit immediately to the left of the close (X) button.
    const closeIndex = header.get_children().indexOf(header.closeButton);
    if (closeIndex >= 0)
        header.insert_child_at_index(trashButton, closeIndex);
    else
        header.add_child(trashButton);

    message._pigeonTrashButton = trashButton;
}
