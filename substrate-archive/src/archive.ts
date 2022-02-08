import { ResilientRpcClient } from "@subsquid/rpc-client/lib/resilient"
import {
    decodeMetadata,
    decodeExtrinsic,
    getChainDescriptionFromMetadata,
    getOldTypesBundle,
    SpecVersion,
    Extrinsic,
    ChainDescription,
    OldTypes,
} from "@subsquid/substrate-metadata"
import {Codec} from "@subsquid/scale-codec"
import {getTypesFromBundle} from "@subsquid/substrate-metadata/lib/old/typesBundle"
import {toCamelCase, assertNotNull} from "@subsquid/util"
import {xxhashAsU8a} from "@polkadot/util-crypto"
import {getConnection} from "./db"
import {Client} from "pg"

interface RuntimeVersion {
    specVersion: SpecVersion
}

type RawExtrinsic = string
type RawMetadata = string
type Spec = number
type QualifiedName = string

interface BlockHeader {
    parentHash: string
}

interface Block {
    header: BlockHeader
    extrinsics: RawExtrinsic[]
}

interface SignedBlock {
    block: Block
}

interface BlockEntity {  // TODO: rename/remove entity postfix
    id: string
    height: number
    hash: string
    parent_hash: string
    timestamp: number
}

interface EventEntity {
    id: string
    block_id: string
    name: QualifiedName
    args: unknown
}

interface ExtrinsicEntity {
    id: string
    block_id: string
    name: QualifiedName
    tip: BigInt
    nonce: number
    hash: string
}

interface CallEntity {
    extrinsic_id: string
    args: unknown
}

interface MetadataEntity {
    spec: Spec
    block_height: number
    block_hash: number
    data: string
}

interface SpecDescription {
    spec: SpecVersion
    description: ChainDescription
}


interface LastBlock extends BlockEntity {
    spec: SpecVersion
}


interface ExtrinsicCall {
    __kind: string,
    value: {__kind: string, [key: string]: any}
}


interface Event {
    __kind: string
    value: {__kind: string, value: any}
}


function getQualifiedName(eventOrCall: ExtrinsicCall | Event): QualifiedName {
    let section = toCamelCase(eventOrCall.__kind)
    return `${section}.${eventOrCall.value.__kind}`
}


/**
 * All blocks have timestamp event except for the genesic block.
 * This method looks up `timestamp.set` and reads off the block timestamp
 *
 * @param extrinsics block extrinsics
 * @returns timestamp as set by a `timestamp.set` call
 */
function getBlockTimestamp(extrinsics: Extrinsic[]): number {
    let extrinsic = extrinsics.find(extrinsic => {
        if (extrinsic.call.__kind !== 'Timestamp') return false
        return extrinsic.call.value.__kind === 'set'
    })
    return extrinsic ? extrinsic.call.value.now : 0
}


export const BLOCK_PAD_LENGTH = 10
export const INDEX_PAD_LENGTH = 6
export const HASH_PAD_LENGTH = 5


/**
 * Formats the event id into a fixed-lentgth string. When formatted the natural string ordering
 * is the same as the ordering
 * in the blockchain (first ordered by block height, then by block ID)
 *
 * @return  id in the format 000000..00<blockNum>-000<index>-<shorthash>
 *
 */
function formatId(height: number, hash: string, index?: number): string {
    const blockPart = `${String(height).padStart(BLOCK_PAD_LENGTH, '0')}`
    const indexPart =
      index !== undefined
        ? `-${String(index).padStart(INDEX_PAD_LENGTH, '0')}`
        : ''
    const _hash = hash.startsWith('0x') ? hash.substring(2) : hash
    const shortHash =
      _hash.length < HASH_PAD_LENGTH
        ? _hash.padEnd(HASH_PAD_LENGTH, '0')
        : _hash.slice(0, HASH_PAD_LENGTH)
    return `${blockPart}${indexPart}-${shortHash}`
}


function omit(obj: any, ...keys: string[]): any {
    let copy = {...obj}
    keys.forEach(key => {
        delete copy[key]
    })
    return copy
}


export class SubstrateArchive {
    private client: ResilientRpcClient
    private typesBundle?: string
    private specDescription?: SpecDescription
    private lastBlock?: LastBlock

    constructor(url: string, typesBundle?: string) {
        this.client = new ResilientRpcClient(url)
        this.typesBundle = typesBundle
    }

    async run(): Promise<void> {
        let db = await getConnection()

        this.lastBlock = await this.getLastBlock(db)
        let blockHeight = this.lastBlock ? this.lastBlock.height + 1 : 1

        while (true) {
            console.log(`Processing block at ${blockHeight}`)
            let blockHash = await this.client.call<string>("chain_getBlockHash", [blockHeight])
            let runtimeVersion = await this.client.call<RuntimeVersion>("chain_getRuntimeVersion", [blockHash])
            let signedBlock = await this.client.call<SignedBlock>("chain_getBlock", [blockHash])
            let header = await this.client.call("chain_getHeader", [blockHash])  // TODO: decode block author

            let oldTypes = this.getOldTypes(runtimeVersion.specVersion)
            let specDescription = await this.getSpecDescription(db, blockHash, blockHeight, runtimeVersion.specVersion, oldTypes)

            let storageKey = "0x" + Buffer.from([
                ...xxhashAsU8a("System", 128),
                ...xxhashAsU8a("Events", 128)
            ]).toString("hex")
            let rawEvents = await this.client.call("state_getStorageAt", [storageKey, blockHash])
            let codec = new Codec(specDescription.description.types)
            let events = codec.decodeBinary(specDescription.description.eventRecordList, rawEvents)
            let eventEntities: EventEntity[] = []
            let blockId = formatId(blockHeight, blockHash)
            events.forEach((decodedEvent: any, index: number) => {
                let eventEntity = {
                    id: formatId(blockHeight, blockHash, index),
                    block_id: blockId,
                    name: getQualifiedName(decodedEvent.event),
                    args: decodedEvent.event.value.value,
                }
                eventEntities.push(eventEntity)
            })

            let extrinsics: Extrinsic[] = []
            let extrinsicEntities: ExtrinsicEntity[] = []
            let callEntities: CallEntity[] = []
            signedBlock.block.extrinsics.forEach((extrinsic, index) => {
                let decodedExtrinsic = decodeExtrinsic(extrinsic, assertNotNull(specDescription).description)
                extrinsics.push(decodedExtrinsic)
                let extrinsicId = formatId(blockHeight, blockHash, index)
                let extrinsicEntity = {
                    id: extrinsicId,
                    block_id: blockId,
                    name: getQualifiedName(decodedExtrinsic.call),
                    tip: decodedExtrinsic.signature?.tip || 0n,
                    nonce: decodedExtrinsic.signature?.nonce || 0,
                    hash: decodedExtrinsic.hash,
                }
                extrinsicEntities.push(extrinsicEntity)
                if (decodedExtrinsic.call.__kind == "Utility" && decodedExtrinsic.call.value.__kind == "batch") {
                    decodedExtrinsic.call.value.calls.forEach((call: any) => {
                        let callEntity = {
                            extrinsic_id: extrinsicId,
                            args: omit(call.value, "__kind"),
                        }
                        callEntities.push(callEntity)
                    })
                } else {
                    let callEntity = {
                        extrinsic_id: extrinsicId,
                        args: omit(decodedExtrinsic.call.value, "__kind"),
                    }
                    callEntities.push(callEntity)
                }
            })

            let blockEntity = {
                id: blockId,
                height: blockHeight,
                hash: blockHash,
                parent_hash: signedBlock.block.header.parentHash,
                timestamp: getBlockTimestamp(extrinsics),
            }

            // is there more than one query to db?
            try {
                await db.query("BEGIN")
                let queries: Promise<any>[] = []
                queries.push(
                    db.query(
                        "INSERT INTO block(id, height, hash, parent_hash, timestamp) VALUES($1, $2, $3, $4, $5)",
                        Object.values(blockEntity)
                    )
                )
                extrinsicEntities.forEach(extrinsicEntity => {
                    queries.push(
                        db.query(
                            "INSERT INTO extrinsic(id, block_id, name, tip, nonce, hash) VALUES($1, $2, $3, $4, $5, $6)",
                            Object.values(extrinsicEntity),
                        )
                    )
                })
                callEntities.forEach(callEntity => {
                    queries.push(
                        db.query(
                            "INSERT INTO call(extrinsic_id, args) VALUES($1, $2)",
                            Object.values(callEntity)
                        )
                    )
                })
                eventEntities.forEach(eventEntity => {
                    queries.push(
                        db.query(
                            "INSERT INTO event(id, block_id, name, args) VALUES($1, $2, $3, $4)",
                            Object.values(eventEntity)
                        )
                    )
                })
                await Promise.all(queries)
                await db.query("COMMIT")
            } catch (e) {
                await db.query("ROLLBACK")
                throw e
            }

            // TODO: disconnect from db
            this.lastBlock = {...blockEntity, spec: runtimeVersion.specVersion}
            blockHeight++
        }
    }

    private async getLastBlock(db: Client): Promise<LastBlock | undefined> {
        let lastBlock: LastBlock | undefined
        let res = await db.query<BlockEntity>("SELECT * FROM block ORDER BY height LIMIT 1")  // potential problem with forks
        if (res.rows.length == 1) {
            let blockEntity = res.rows[0]
            let runtimeVersion = await this.client.call<RuntimeVersion>("chain_getRuntimeVersion", [blockEntity.hash])
            lastBlock = {...blockEntity, spec: runtimeVersion.specVersion}
        }
        return lastBlock
    }

    private getOldTypes(spec: SpecVersion): OldTypes | undefined {
        let oldTypes
        if (this.typesBundle) {
            let typesBundle = assertNotNull(getOldTypesBundle(this.typesBundle))
            oldTypes = getTypesFromBundle(typesBundle, spec)
        }
        return oldTypes
    }

    private async getSpecDescription(
        db: Client,
        blockHash: string,
        blockHeight: number,
        spec: SpecVersion,
        oldTypes?: OldTypes
    ): Promise<SpecDescription> {
        let specDescription
        if (this.lastBlock === undefined) {  // start indexing
            let rawMetadata = await this.client.call<RawMetadata>("state_getMetadata", [blockHash])
            let metadata = decodeMetadata(rawMetadata)
            let description = getChainDescriptionFromMetadata(metadata, oldTypes)
            specDescription = {spec, description}

            let metadataEntity = {
                spec,
                block_height: blockHeight,
                block_hash: blockHash,
                data: rawMetadata,
            }
            await db.query(
                "INSERT INTO metadata(spec, block_height, block_hash, data) VALUES($1, $2, $3, $4)",
                Object.values(metadataEntity)
            )
        } else if (this.specDescription === undefined) {  // resume indexing
            if (spec == this.lastBlock.spec) {
                let rawMetadata = await this.client.call<RawMetadata>("state_getMetadata", [blockHash])
                let metadata = decodeMetadata(rawMetadata)
                let description = getChainDescriptionFromMetadata(metadata, oldTypes)
                specDescription = {spec, description}
            } else {
                let rawMetadata = await this.client.call<RawMetadata>("state_getMetadata", [this.lastBlock.hash])
                let metadata = decodeMetadata(rawMetadata)
                let description = getChainDescriptionFromMetadata(metadata, oldTypes)
                specDescription = {spec: this.lastBlock.spec, description}

                let metadataEntity = {
                    spec: this.lastBlock.spec,
                    block_height: this.lastBlock.height,
                    block_hash: this.lastBlock.hash,
                    data: rawMetadata,
                }
                await db.query(
                    "INSERT INTO metadata(spec, block_height, block_hash, data) VALUES($1, $2, $3, $4)",
                    Object.values(metadataEntity)
                )
            }
        } else {
            if (this.specDescription.spec != spec && spec == this.lastBlock.spec) {
                let rawMetadata = await this.client.call<RawMetadata>("state_getMetadata", [this.lastBlock.hash])
                let metadata = decodeMetadata(rawMetadata)
                let description = getChainDescriptionFromMetadata(metadata, oldTypes)
                specDescription = {spec: this.lastBlock.spec, description}

                let metadataEntity = {
                    spec: this.lastBlock.spec,
                    block_height: this.lastBlock.height,
                    block_hash: this.lastBlock.hash,
                    data: rawMetadata,
                }
                await db.query(
                    "INSERT INTO metadata(spec, block_height, block_hash, data) VALUES($1, $2, $3, $4)",
                    Object.values(metadataEntity)
                )
            } else {
                specDescription = this.specDescription
            }
        }
        return specDescription
    }
}
