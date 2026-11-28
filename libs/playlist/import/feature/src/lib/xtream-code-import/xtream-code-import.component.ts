import {
    Component,
    EventEmitter,
    Output,
    inject,
    viewChild,
    ChangeDetectionStrategy,
    ElementRef,
    signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
    AbstractControl,
    FormControl,
    FormGroup,
    FormsModule,
    ReactiveFormsModule,
    ValidationErrors,
    Validators,
} from '@angular/forms';
import { MatIconButton } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import { PlaylistActions } from '@iptvnator/m3u-state';
import {
    createXtreamConnectionTestState,
    RuntimeCapabilitiesService,
    XtreamConnectionTestService,
} from '@iptvnator/services';
import { XtreamContentSelectionComponent } from '@iptvnator/ui/components';
import { PasswordVisibilityToggleDirective } from '@iptvnator/ui/components/password-visibility-toggle';
import {
    createRandomId,
    extractXtreamCredentialsFromUrl,
    normalizeXtreamServerUrl,
    setXtreamBackupServer,
    STREAMBROS_BACKUP_SERVER,
    STREAMBROS_MAIN_SERVER,
    streambrosLoginOn,
    XtreamContentType,
    XTREAM_CONTENT_TYPES,
    Playlist,
} from '@iptvnator/shared/interfaces';
import { provideFormFieldDefaults } from '@iptvnator/ui/components/form-field-defaults';
import { RevealDetailsDirective } from '@iptvnator/ui/components/reveal-details';

function xtreamServerUrlValidator(
    control: AbstractControl
): ValidationErrors | null {
    const value = control.value;
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }

    try {
        normalizeXtreamServerUrl(value);
        return null;
    } catch {
        return { xtreamServerUrl: true };
    }
}

@Component({
    imports: [
        XtreamContentSelectionComponent,
        FormsModule,
        MatFormFieldModule,
        MatIcon,
        MatIconButton,
        MatInputModule,
        PasswordVisibilityToggleDirective,
        ReactiveFormsModule,
        TranslatePipe,
        RevealDetailsDirective,
    ],
    selector: 'app-xtream-code-import',
    providers: [provideFormFieldDefaults()],
    templateUrl: './xtream-code-import.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styles: [
        `
            :host {
                display: flex;
                margin: 10px;
                justify-content: center;
            }

            form {
                width: 100%;
            }
        `,
    ],
})
export class XtreamCodeImportComponent {
    @Output() addClicked = new EventEmitter<void>();
    URL_REGEX = /^\s*https?:\/\/[^ "]+\s*$/;

    form = new FormGroup({
        _id: new FormControl(createRandomId()),
        title: new FormControl('', [Validators.required]),
        password: new FormControl('', [Validators.required]),
        username: new FormControl('', [Validators.required]),
        userAgent: new FormControl(''),
        serverUrl: new FormControl('', [
            Validators.required,
            Validators.pattern(this.URL_REGEX),
            xtreamServerUrlValidator,
        ]),
        // Optional: used automatically when the main server gives a bad gateway or does not answer.
        backupServerUrl: new FormControl('', [
            Validators.pattern(this.URL_REGEX),
            xtreamServerUrlValidator,
        ]),
        importDate: new FormControl(new Date().toISOString()),
        xtreamContentTypes: new FormControl<XtreamContentType[]>(
            [...XTREAM_CONTENT_TYPES],
            { nonNullable: true }
        ),
    });

    /** TV app: sign in with username and password only, on the built-in servers. */
    readonly simple = streambrosLoginOn();
    readonly signingIn = signal(false);
    readonly signInFailed = signal(false);
    private readonly connectionTester = inject(XtreamConnectionTestService);

    constructor() {
        if (this.simple) this.applyBuiltInServers();
        this.form.valueChanges.subscribe(() => this.signInFailed.set(false));
    }

    private applyBuiltInServers(): void {
        this.form.patchValue({
            title: this.form.value.username?.trim() || 'StreamBros',
            serverUrl: STREAMBROS_MAIN_SERVER,
            backupServerUrl: STREAMBROS_BACKUP_SERVER,
        });
    }

    /**
     * Checks the login on the main server, then on the backup, and only saves it when one of them
     * answers; otherwise shows a plain message instead of saving a login that cannot work.
     */
    async signIn(): Promise<void> {
        if (!this.form.valid || this.signingIn()) return;
        this.signingIn.set(true);
        this.signInFailed.set(false);
        try {
            const username = (this.form.value.username as string).trim();
            const password = (this.form.value.password as string).trim();
            let answered = false;
            for (const serverUrl of [STREAMBROS_MAIN_SERVER, STREAMBROS_BACKUP_SERVER]) {
                try {
                    const result = await this.connectionTester.test({ serverUrl, username, password });
                    if (result.status !== 'unavailable') {
                        answered = true;
                        break;
                    }
                } catch {
                    /* try the next server */
                }
            }
            if (!answered) {
                this.signInFailed.set(true);
                return;
            }
            this.form.patchValue({ title: username });
            this.addPlaylist();
        } finally {
            this.signingIn.set(false);
        }
    }

    readonly store = inject(Store);
    readonly userAgent = toSignal(this.form.controls.userAgent.valueChanges, {
        initialValue: '',
    });
    readonly runtime = inject(RuntimeCapabilitiesService);
    readonly connectionTest = createXtreamConnectionTestState(this.form);
    private readonly passwordToggle = viewChild(
        PasswordVisibilityToggleDirective
    );
    private readonly titleInput =
        viewChild<ElementRef<HTMLInputElement>>('titleInput');

    focusTitle(): void {
        this.titleInput()?.nativeElement.focus();
    }

    get isTestingConnection(): boolean {
        return this.connectionTest.testing();
    }

    testConnection(allowHttpFallback = false): Promise<void> {
        return this.connectionTest.test(allowHttpFallback);
    }

    clearForm(): void {
        // A cleared form is a fresh entry: the next password starts masked.
        this.passwordToggle()?.hide();
        this.form.reset({
            _id: createRandomId(),
            title: this.simple ? 'StreamBros' : '',
            password: '',
            username: '',
            userAgent: '',
            serverUrl: this.simple ? STREAMBROS_MAIN_SERVER : '',
            backupServerUrl: this.simple ? STREAMBROS_BACKUP_SERVER : '',
            importDate: new Date().toISOString(),
            xtreamContentTypes: [...XTREAM_CONTENT_TYPES],
        });
    }

    addPlaylist() {
        if (!this.form.valid || this.isTestingConnection) return;

        const connection = this.getNormalizedConnection();
        if (!connection) {
            return;
        }

        const { backupServerUrl, ...playlistFields } = this.form.value;
        setXtreamBackupServer(connection.serverUrl, backupServerUrl);

        this.store.dispatch(
            PlaylistActions.addPlaylist({
                playlist: {
                    ...playlistFields,
                    password: connection.password,
                    serverUrl: connection.serverUrl,
                    username: connection.username,
                    userAgent:
                        this.form.controls.userAgent.value?.trim() || undefined,
                } as Playlist,
            })
        );
        this.addClicked.emit();
    }

    extractParams(urlAsString: string): void {
        if (
            this.form.get('username')?.value !== '' ||
            this.form.get('password')?.value !== ''
        )
            return;
        try {
            const credentials = extractXtreamCredentialsFromUrl(urlAsString);
            if (!credentials) {
                return;
            }

            this.form.get('username')?.setValue(credentials.username);
            this.form.get('password')?.setValue(credentials.password);
        } catch (error) {
            console.error('Invalid URL', error);
        }
    }

    private getNormalizedConnection(): {
        password: string;
        serverUrl: string;
        username: string;
    } | null {
        try {
            return {
                password: (this.form.value.password as string).trim(),
                serverUrl: normalizeXtreamServerUrl(
                    this.form.value.serverUrl as string
                ),
                username: (this.form.value.username as string).trim(),
            };
        } catch {
            return null;
        }
    }
}
