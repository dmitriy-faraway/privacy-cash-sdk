import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { deposit } from './deposit.js';
import { getBalanceFromUtxos, getUtxos, localstorageKey } from './getUtxos.js';
import { getBalanceFromUtxosSPL, getUtxosSPL } from './getUtxosSPL.js';

import { LSK_ENCRYPTED_OUTPUTS, LSK_FETCH_OFFSET, SplList, TokenList, tokens, USDC_MINT } from './utils/constants.js';
import { logger, type LoggerFn, setLogger } from './utils/logger.js';
import { EncryptionService } from './utils/encryption.js';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import bs58 from 'bs58'
import { withdraw } from './withdraw.js';
// import { LocalStorage } from "node-localstorage";
// import path from 'node:path'
import { depositSPL } from './depositSPL.js';
import { withdrawSPL } from './withdrawSPL.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

const storage = globalThis.localStorage;
const keyBasePath = 'https://privacycash.org/circuit2';

export class PrivacyCash {
    public publicKey: PublicKey
    private encryptionService: EncryptionService
    private keypair: Keypair | null = null
    private isRuning?: boolean = false
    private status: string = ''
    private utxosOffset?: number
    private utxosSplOffset?: number
    private getConnection: () => Promise<Connection>;
    constructor({ RPC_url, owner, signature, enableDebug, getConnection, publicKey, utxosOffset, utxosSplOffset }: {
        RPC_url?: string,
        publicKey: PublicKey;
        getConnection?: () => Promise<Connection>,
        owner?: string | number[] | Uint8Array | Keypair,
        signature?: Uint8Array,
        enableDebug?: boolean,
        utxosOffset?: number,
        utxosSplOffset?: number,
    }) {
        this.utxosOffset = utxosOffset;
        this.utxosSplOffset = utxosSplOffset;
        this.publicKey = publicKey;
        if (!owner && !signature) {
            throw new Error('param "owner" or "signature" is required')
        }

        if (owner) {
            this.keypair = getSolanaKeypair(owner)
        }

        if (!getConnection && !RPC_url) {
            throw new Error('param "getConnection" or "RPC_url" is required')
        }

        if (getConnection) {
            this.getConnection = getConnection;
        } else {
            const connection = new Connection(RPC_url!, 'confirmed');
            this.getConnection = () => Promise.resolve(connection);
        }

        this.encryptionService = new EncryptionService();
        if (this.keypair) {
            this.publicKey = this.keypair.publicKey
            this.encryptionService.deriveEncryptionKeyFromWallet(this.keypair);
        } else {
            this.encryptionService.deriveEncryptionKeyFromSignature(signature!);
        }

        if (!enableDebug) {
            this.startStatusRender()
            this.setLogger((level, message) => {
                if (level == 'info') {
                    this.status = message
                } else if (level == 'error') {
                    console.log('error message: ', message)
                }
            })
        }
    }

    setLogger(loger: LoggerFn) {
        setLogger(loger)
        return this
    }

    /**
     * Clears the cache of utxos.
     * 
     * By default, downloaded utxos will be cached in the local storage. Thus the next time when you makes another
     * deposit or withdraw or getPrivateBalance, the SDK only fetches the utxos that are not in the cache.
     * 
     * This method clears the cache of utxos.
     */
    async clearCache() {
        if (!this.publicKey) {
            return this
        }
        storage.removeItem(LSK_FETCH_OFFSET + localstorageKey(this.publicKey))
        storage.removeItem(LSK_ENCRYPTED_OUTPUTS + localstorageKey(this.publicKey))
        // spl
        for (let token of tokens) {
            let ata = await getAssociatedTokenAddress(
                token.pubkey,
                this.publicKey
            );
            storage.removeItem(LSK_FETCH_OFFSET + localstorageKey(ata))
            storage.removeItem(LSK_ENCRYPTED_OUTPUTS + localstorageKey(ata))
        }
        return this
    }

    /**
     * Deposit SOL to the Privacy Cash.
     * 
     * Lamports is the amount of SOL in lamports. e.g. if you want to deposit 0.01 SOL (10000000 lamports), call deposit({ lamports: 10000000 })
     */
    async deposit({ lamports, signer, signTransaction }: {
        lamports: number,
        signer?: PublicKey;
        signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    }) {
        this.isRuning = true
        logger.info('start depositting')
        let lightWasm = await WasmFactory.getInstance()
        const connection = await this.getConnection();
        const transactionSigner = signTransaction ? signTransaction : async (tx: VersionedTransaction) => {
            tx.sign([this.keypair!])
            return tx
        }

        let res = await deposit({
            lightWasm,
            amount_in_lamports: lamports,
            connection: connection,
            encryptionService: this.encryptionService,
            publicKey: this.publicKey,
            transactionSigner,
            keyBasePath,
            storage,
            signer,
            utxosOffset: this.utxosOffset
        })
        this.isRuning = false
        return res
    }

    /**
    * Deposit USDC to the Privacy Cash.
    */
    async depositUSDC({ base_units, signer, signTransaction }: {
        base_units: number,
        signer?: PublicKey,
        signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    }) {
        this.isRuning = true
        logger.info('start depositting')
        let lightWasm = await WasmFactory.getInstance()
        const connection = await this.getConnection();
        const transactionSigner = signTransaction ? signTransaction : async (tx: VersionedTransaction) => {
            tx.sign([this.keypair!])
            return tx
        }
        let res = await depositSPL({
            mintAddress: USDC_MINT,
            lightWasm,
            base_units: base_units,
            connection: connection,
            encryptionService: this.encryptionService,
            publicKey: this.publicKey,
            transactionSigner,
            keyBasePath,
            storage,
            signer,
            utxosSplOffset: this.utxosSplOffset
        })
        this.isRuning = false
        return res
    }

    /**
     * Withdraw SOL from the Privacy Cash.
     * 
     * Lamports is the amount of SOL in lamports. e.g. if you want to withdraw 0.01 SOL (10000000 lamports), call withdraw({ lamports: 10000000 })
     */
    async withdraw({ lamports, recipientAddress, referrer }: {
        lamports: number,
        recipientAddress?: string,
        referrer?: string
    }) {
        this.isRuning = true
        logger.info('start withdrawing')
        let lightWasm = await WasmFactory.getInstance()
        let recipient = recipientAddress ? new PublicKey(recipientAddress) : this.publicKey
        const connection = await this.getConnection();
        let res = await withdraw({
            lightWasm,
            amount_in_lamports: lamports,
            connection: connection,
            encryptionService: this.encryptionService,
            publicKey: this.publicKey,
            recipient,
            keyBasePath,
            storage,
            referrer,
            utxosOffset: this.utxosOffset
        })
        logger.debug(`Withdraw successful. Recipient ${recipient} received ${res.amount_in_lamports / LAMPORTS_PER_SOL} SOL, with ${res.fee_in_lamports / LAMPORTS_PER_SOL} SOL relayers fees`)
        this.isRuning = false
        return res
    }

    /**
      * Withdraw USDC from the Privacy Cash.
      * 
      * base_units is the amount of USDC in base unit. e.g. if you want to withdraw 1 USDC (1,000,000 base unit), call withdraw({ base_units: 1000000, recipientAddress: 'some_address' })
      */
    async withdrawUSDC({ base_units, recipientAddress, referrer }: {
        base_units: number,
        recipientAddress?: string,
        referrer?: string
    }) {
        this.isRuning = true
        logger.info('start withdrawing')
        let lightWasm = await WasmFactory.getInstance()
        let recipient = recipientAddress ? new PublicKey(recipientAddress) : this.publicKey
        const connection = await this.getConnection();
        let res = await withdrawSPL({
            mintAddress: USDC_MINT,
            lightWasm,
            base_units,
            connection: connection,
            encryptionService: this.encryptionService,
            publicKey: this.publicKey,
            recipient,
            keyBasePath,
            storage,
            referrer
        })
        logger.debug(`Withdraw successful. Recipient ${recipient} received ${base_units} USDC units`)
        this.isRuning = false
        return res
    }

    /**
     * Returns the amount of lamports current wallet has in Privacy Cash.
     */
    async getPrivateBalance(abortSignal?: AbortSignal) {
        logger.info('getting private balance')
        this.isRuning = true
        const connection = await this.getConnection();
        let utxos = await getUtxos({ publicKey: this.publicKey, connection: connection, encryptionService: this.encryptionService, storage, abortSignal, offset: this.utxosOffset })
        this.isRuning = false
        return getBalanceFromUtxos(utxos)
    }

    /**
    * Returns the amount of base unites current wallet has in Privacy Cash.
    */
    async getPrivateBalanceUSDC() {
        logger.info('getting private balance')
        this.isRuning = true
        const connection = await this.getConnection();
        let utxos = await getUtxosSPL({ publicKey: this.publicKey, connection: connection, encryptionService: this.encryptionService, storage, mintAddress: USDC_MINT, offset: this.utxosSplOffset })
        this.isRuning = false
        return getBalanceFromUtxosSPL(utxos)
    }

    /**
    * Returns the amount of base unites current wallet has in Privacy Cash.
    */
    async getPrivateBalanceSpl(mintAddress: PublicKey | string) {
        this.isRuning = true
        const connection = await this.getConnection();
        let utxos = await getUtxosSPL({
            publicKey: this.publicKey,
            connection: connection,
            encryptionService: this.encryptionService,
            storage,
            mintAddress,
            offset: this.utxosSplOffset
        })
        this.isRuning = false
        return getBalanceFromUtxosSPL(utxos)
    }

    /**
     * Returns true if the code is running in a browser.
     */
    isBrowser() {
        return typeof window !== "undefined"
    }

    async startStatusRender() {
        let frames = ['-', '\\', '|', '/'];
        let i = 0
        while (true) {
            if (this.isRuning) {
                let k = i % frames.length
                i++
                stdWrite(this.status, frames[k])
            }
            await new Promise(r => setTimeout(r, 250));
        }
    }

    /**
   * Deposit SPL to the Privacy Cash.
   */
    async depositSPL({ base_units, mintAddress, amount, signer, signTransaction }: {
        base_units?: number,
        amount?: number,
        mintAddress: PublicKey | string,
        signer?: PublicKey,
        signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    }) {
        this.isRuning = true
        logger.info('start depositting')
        let lightWasm = await WasmFactory.getInstance()
        const connection = await this.getConnection();
        const transactionSigner = signTransaction ? signTransaction : async (tx: VersionedTransaction) => {
            tx.sign([this.keypair!])
            return tx
        }
        let res = await depositSPL({
            lightWasm,
            base_units,
            amount,
            connection: connection,
            encryptionService: this.encryptionService,
            publicKey: this.publicKey,
            transactionSigner,
            keyBasePath,
            storage,
            mintAddress,
            signer,
            utxosSplOffset: this.utxosSplOffset
        })
        this.isRuning = false
        return res
    }

    /**
      * Withdraw SPL from the Privacy Cash.
      */
    async withdrawSPL({ base_units, mintAddress, recipientAddress, amount, referrer }: {
        base_units?: number,
        amount?: number,
        mintAddress: PublicKey | string,
        recipientAddress?: string,
        referrer?: string
    }) {
        this.isRuning = true
        logger.info('start withdrawing')
        let lightWasm = await WasmFactory.getInstance()
        let recipient = recipientAddress ? new PublicKey(recipientAddress) : this.publicKey
        const connection = await this.getConnection();
        let res = await withdrawSPL({
            lightWasm,
            base_units,
            amount,
            connection: connection,
            encryptionService: this.encryptionService,
            publicKey: this.publicKey,
            recipient,
            keyBasePath,
            storage,
            mintAddress,
            referrer,
            utxosSplOffset: this.utxosSplOffset
        })
        logger.debug(`Withdraw successful. Recipient ${recipient} received ${base_units} USDC units`)
        this.isRuning = false
        return res
    }


}

function getSolanaKeypair(
    secret: string | number[] | Uint8Array | Keypair
): Keypair | null {
    try {
        if (secret instanceof Keypair) {
            return secret;
        }

        let keyArray: Uint8Array;

        if (typeof secret === "string") {
            keyArray = bs58.decode(secret);
        } else if (secret instanceof Uint8Array) {
            keyArray = secret;
        } else {
            // number[]
            keyArray = Uint8Array.from(secret);
        }

        if (keyArray.length !== 32 && keyArray.length !== 64) {
            return null;
        }
        return Keypair.fromSecretKey(keyArray);
    } catch {
        return null;
    }
}

function stdWrite(status: string, frame: string) {
    let blue = "\x1b[34m";
    let reset = "\x1b[0m";
    process.stdout.write(`${frame}status: ${blue}${status}${reset}\r`);
}