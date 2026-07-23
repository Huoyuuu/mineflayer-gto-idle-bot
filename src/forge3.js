'use strict'

const FML3_TAG = '\0FML3\0'
const LOGIN_WRAPPER = 'fml:loginwrapper'
const HANDSHAKE_CHANNEL = 'fml:handshake'
const MAX_COLLECTION_SIZE = 100000
const MAX_STRING_BYTES = 1024 * 1024

function readVarInt (buffer, offset = 0) {
  let value = 0
  let position = 0
  let cursor = offset

  while (cursor < buffer.length) {
    const byte = buffer[cursor++]
    value |= (byte & 0x7f) << position
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: cursor }
    position += 7
    if (position >= 35) throw new Error('VarInt exceeds 5 bytes')
  }
  throw new Error('Truncated VarInt')
}

function writeVarInt (value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error(`Invalid VarInt value: ${value}`)
  }
  const bytes = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function readString (buffer, offset) {
  const length = readVarInt(buffer, offset)
  if (length.value > MAX_STRING_BYTES) throw new Error(`String too large: ${length.value}`)
  const end = length.offset + length.value
  if (end > buffer.length) throw new Error('Truncated string')
  return { value: buffer.toString('utf8', length.offset, end), offset: end }
}

function writeString (value) {
  const data = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(data.length), data])
}

function readArray (buffer, offset, reader) {
  const count = readVarInt(buffer, offset)
  if (count.value > MAX_COLLECTION_SIZE) throw new Error(`Collection too large: ${count.value}`)
  const values = []
  let cursor = count.offset
  for (let index = 0; index < count.value; index++) {
    const result = reader(buffer, cursor)
    values.push(result.value)
    cursor = result.offset
  }
  return { value: values, offset: cursor }
}

function writeArray (values, writer) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writer)])
}

function parseLoginWrapper (buffer) {
  const channel = readString(buffer, 0)
  const length = readVarInt(buffer, channel.offset)
  const end = length.offset + length.value
  if (end > buffer.length) throw new Error('Truncated login-wrapper payload')
  return { channel: channel.value, data: buffer.subarray(length.offset, end) }
}

function encodeLoginWrapper (channel, data) {
  return Buffer.concat([writeString(channel), writeVarInt(data.length), data])
}

function parseModList (buffer) {
  const discriminator = readVarInt(buffer, 0)
  if (discriminator.value !== 1) throw new Error(`Expected ModList discriminator, got ${discriminator.value}`)
  let cursor = discriminator.offset

  const mods = readArray(buffer, cursor, readString)
  cursor = mods.offset
  const channels = readArray(buffer, cursor, (source, offset) => {
    const name = readString(source, offset)
    const marker = readString(source, name.offset)
    return { value: { name: name.value, marker: marker.value }, offset: marker.offset }
  })
  cursor = channels.offset
  const registries = readArray(buffer, cursor, (source, offset) => {
    const name = readString(source, offset)
    return { value: { name: name.value }, offset: name.offset }
  })
  cursor = registries.offset
  const dataPackRegistries = readArray(buffer, cursor, (source, offset) => {
    const name = readString(source, offset)
    return { value: { name: name.value }, offset: name.offset }
  })

  return {
    modNames: mods.value,
    channels: channels.value,
    registries: registries.value,
    dataPackRegistries: dataPackRegistries.value,
    consumed: dataPackRegistries.offset
  }
}

function parseRegistrySnapshot (buffer) {
  const discriminator = readVarInt(buffer, 0)
  if (discriminator.value !== 3) throw new Error(`Expected registry discriminator, got ${discriminator.value}`)
  const registry = readString(buffer, discriminator.offset)
  if (registry.offset >= buffer.length) throw new Error('Truncated registry snapshot flag')
  const hasSnapshot = buffer[registry.offset] !== 0
  let cursor = registry.offset + 1
  if (!hasSnapshot) {
    return {
      registryName: registry.value,
      hasSnapshot: false,
      ids: [],
      aliases: [],
      overrides: [],
      blocked: [],
      consumed: cursor
    }
  }

  const ids = readArray(buffer, cursor, (source, offset) => {
    const name = readString(source, offset)
    const id = readVarInt(source, name.offset)
    return { value: { name: name.value, id: id.value }, offset: id.offset }
  })
  cursor = ids.offset
  const aliases = readArray(buffer, cursor, (source, offset) => {
    const from = readString(source, offset)
    const to = readString(source, from.offset)
    return { value: { from: from.value, to: to.value }, offset: to.offset }
  })
  cursor = aliases.offset
  const overrides = readArray(buffer, cursor, (source, offset) => {
    const name = readString(source, offset)
    const owner = readString(source, name.offset)
    return { value: { name: name.value, owner: owner.value }, offset: owner.offset }
  })
  cursor = overrides.offset
  const blocked = readArray(buffer, cursor, (source, offset) => {
    const id = readVarInt(source, offset)
    return { value: id.value, offset: id.offset }
  })

  return {
    registryName: registry.value,
    hasSnapshot: true,
    ids: ids.value,
    aliases: aliases.value,
    overrides: overrides.value,
    blocked: blocked.value,
    consumed: blocked.offset
  }
}

function buildModListReply (modList) {
  const channels = modList.channels.filter(channel => channel.marker !== 'FML3')
  const registries = modList.registries.map(registry => ({ ...registry, marker: '1.0' }))
  return Buffer.concat([
    writeVarInt(2),
    writeArray(modList.modNames, writeString),
    writeArray(channels, channel => Buffer.concat([writeString(channel.name), writeString(channel.marker)])),
    writeArray(registries, registry => Buffer.concat([writeString(registry.name), writeString(registry.marker)]))
  ])
}

function buildAcknowledgement () {
  return writeVarInt(99)
}

function removeDefaultLoginHandler (client) {
  for (const listener of client.listeners('login_plugin_request')) {
    if (listener.name === 'onLoginPluginRequest') {
      client.removeListener('login_plugin_request', listener)
    }
  }
}

function installForge3 (client, options = {}) {
  if (client.gtoForge3Installed) return
  client.gtoForge3Installed = true
  client.tagHost = FML3_TAG

  const log = options.log || (() => {})
  if (typeof client.registerChannel === 'function') {
    client.registerChannel(LOGIN_WRAPPER, null, false)
  }
  removeDefaultLoginHandler(client)

  client.on('login_plugin_request', packet => {
    if (packet.channel !== LOGIN_WRAPPER) {
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    let wrapper
    try {
      wrapper = parseLoginWrapper(packet.data)
    } catch (error) {
      log(`[forge] invalid login wrapper: ${error.message}`)
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    if (wrapper.channel !== HANDSHAKE_CHANNEL) {
      // GTOCore's login message is LOGIN_TO_CLIENT + noResponse(). Reporting
      // it as unsupported matches a real client without that optional handler.
      log(`[forge] optional login channel ignored: ${wrapper.channel}`)
      client.write('login_plugin_response', { messageId: packet.messageId })
      return
    }

    try {
      const discriminator = readVarInt(wrapper.data, 0).value
      let response
      if (discriminator === 1) {
        const modList = parseModList(wrapper.data)
        response = buildModListReply(modList)
        if (typeof options.onModList === 'function') options.onModList(modList)
        log(`[forge] reflected ${modList.modNames.length} mods, ${modList.channels.length} channels, ${modList.registries.length} registries`)
      } else if ([3, 4, 5, 6].includes(discriminator)) {
        if (discriminator === 3) {
          try {
            const registry = parseRegistrySnapshot(wrapper.data)
            if (typeof options.onRegistryData === 'function') options.onRegistryData(registry)
            log(`[forge] received ${registry.registryName} registry with ${registry.ids.length} ids`)
          } catch (error) {
            log(`[forge] registry snapshot left opaque: ${error.message}`)
          }
        }
        response = buildAcknowledgement()
        log(`[forge] acknowledged handshake discriminator ${discriminator}`)
      } else {
        log(`[forge] unsupported handshake discriminator ${discriminator}`)
        client.write('login_plugin_response', { messageId: packet.messageId })
        return
      }

      client.write('login_plugin_response', {
        messageId: packet.messageId,
        data: encodeLoginWrapper(HANDSHAKE_CHANNEL, response)
      })
    } catch (error) {
      log(`[forge] handshake error: ${error.message}`)
      client.write('login_plugin_response', { messageId: packet.messageId })
    }
  })
}

module.exports = {
  FML3_TAG,
  HANDSHAKE_CHANNEL,
  buildAcknowledgement,
  buildModListReply,
  encodeLoginWrapper,
  installForge3,
  parseLoginWrapper,
  parseModList,
  parseRegistrySnapshot,
  readVarInt,
  writeString,
  writeVarInt
}
