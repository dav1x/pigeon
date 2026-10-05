import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

import { Manager } from './manager.js';
import { addPigeonTrashButton } from './notificationTrash.js';

export default class Pigeon extends Extension {
    enable() {
        this._injectionManager = new InjectionManager();

        // Redirect Delete actions into a header trash button (next to X)
        // instead of the bottom action row. _addAction is a real prototype
        // method on NotificationMessage; constructor/_init is not reliably
        // overridable with InjectionManager on GNOME 49.
        this._injectionManager.overrideMethod(
            MessageList.NotificationMessage.prototype,
            '_addAction',
            (originalMethod) => {
                return function (action) {
                    if (this.notification?._pigeonOnDelete) {
                        addPigeonTrashButton(this, this.notification);
                        if (this._pigeonTrashButton) {
                            this._actions.set(action, this._pigeonTrashButton);
                            return;
                        }
                        // Fall back to the normal action button if header inject failed.
                    }
                    return originalMethod.call(this, action);
                };
            },
        );

        this._manager = new Manager({
            logger: this.getLogger(),
            settings: this.getSettings(),
        });
    }

    disable() {
        this._manager?.destroy();
        this._manager = null;

        this._injectionManager?.clear();
        this._injectionManager = null;
    }
}
