const tape = require('tape')
const RAM = require('random-access-memory')
const Core = require('../lib/core')

tape('core - append', async function (t) {
  const { core } = await create()

  {
    const seq = await core.append([
      Buffer.from('hello'),
      Buffer.from('world')
    ])

    t.same(seq, 0)
    t.same(core.tree.length, 2)
    t.same(core.tree.byteLength, 10)
    t.same([
      await core.blocks.get(0),
      await core.blocks.get(1)
    ], [
      Buffer.from('hello'),
      Buffer.from('world')
    ])
  }

  {
    const seq = await core.append([
      Buffer.from('hej')
    ])

    t.same(seq, 2)
    t.same(core.tree.length, 3)
    t.same(core.tree.byteLength, 13)
    t.same([
      await core.blocks.get(0),
      await core.blocks.get(1),
      await core.blocks.get(2)
    ], [
      Buffer.from('hello'),
      Buffer.from('world'),
      Buffer.from('hej')
    ])
  }
})

tape('core - append and truncate', async function (t) {
  const { core, reopen } = await create()

  await core.append([
    Buffer.from('hello'),
    Buffer.from('world'),
    Buffer.from('fo'),
    Buffer.from('ooo')
  ])

  await core.truncate(3, 1)

  t.same(core.tree.length, 3)
  t.same(core.tree.byteLength, 12)
  t.same(core.tree.fork, 1)
  t.same(core.header.hints.reorgs, [{ from: 0, to: 1, ancestors: 3 }])

  await core.append([
    Buffer.from('a'),
    Buffer.from('b'),
    Buffer.from('c'),
    Buffer.from('d')
  ])

  await core.truncate(3, 2)

  t.same(core.tree.length, 3)
  t.same(core.tree.byteLength, 12)
  t.same(core.tree.fork, 2)
  t.same(core.header.hints.reorgs, [{ from: 0, to: 1, ancestors: 3 }, { from: 1, to: 2, ancestors: 3 }])

  await core.truncate(2, 3)

  t.same(core.header.hints.reorgs, [{ from: 2, to: 3, ancestors: 2 }])

  await core.append([Buffer.from('a')])
  await core.truncate(2, 4)

  await core.append([Buffer.from('a')])
  await core.truncate(2, 5)

  await core.append([Buffer.from('a')])
  await core.truncate(2, 6)

  await core.append([Buffer.from('a')])
  await core.truncate(2, 7)

  t.same(core.header.hints.reorgs.length, 4)

  // check that it was persisted
  const coreReopen = await reopen()

  t.same(coreReopen.tree.length, 2)
  t.same(coreReopen.tree.byteLength, 10)
  t.same(coreReopen.tree.fork, 7)
  t.same(coreReopen.header.hints.reorgs.length, 4)
})

tape('core - user data', async function (t) {
  const { core, reopen } = await create()

  await core.userData('hello', Buffer.from('world'))
  t.same(core.header.userData, [{ key: 'hello', value: Buffer.from('world') }])

  await core.userData('hej', Buffer.from('verden'))
  t.same(core.header.userData, [
    { key: 'hello', value: Buffer.from('world') },
    { key: 'hej', value: Buffer.from('verden') }
  ])

  await core.userData('hello', null)
  t.same(core.header.userData, [{ key: 'hej', value: Buffer.from('verden') }])

  await core.userData('hej', Buffer.from('world'))
  t.same(core.header.userData, [{ key: 'hej', value: Buffer.from('world') }])

  // check that it was persisted
  const coreReopen = await reopen()

  t.same(coreReopen.header.userData, [{ key: 'hej', value: Buffer.from('world') }])
})

tape('core - verify', async function (t) {
  const { core } = await create()
  const { core: clone } = await create({ keyPair: { publicKey: core.header.signer.publicKey } })

  t.same(clone.header.signer.publicKey, core.header.signer.publicKey)

  await core.append([Buffer.from('a'), Buffer.from('b')])

  {
    const p = await core.tree.proof({ upgrade: { start: 0, length: 2 } })
    await clone.verify(p)
  }

  t.same(clone.header.tree.length, 2)
  t.same(clone.header.tree.signature, core.header.tree.signature)

  {
    const p = await core.tree.proof({ block: { index: 1, nodes: await clone.tree.nodes(2), value: true } })
    p.block.value = await core.blocks.get(1)
    await clone.verify(p)
  }
})

tape('core - verify parallel upgrades', async function (t) {
  const { core } = await create()
  const { core: clone } = await create({ keyPair: { publicKey: core.header.signer.publicKey } })

  t.same(clone.header.signer.publicKey, core.header.signer.publicKey)

  await core.append([Buffer.from('a'), Buffer.from('b'), Buffer.from('c'), Buffer.from('d')])

  {
    const p1 = await core.tree.proof({ upgrade: { start: 0, length: 2 } })
    const p2 = await core.tree.proof({ upgrade: { start: 0, length: 3 } })

    const v1 = clone.verify(p1)
    const v2 = clone.verify(p2)

    await v1
    await v2
  }

  t.same(clone.header.tree.length, core.header.tree.length)
  t.same(clone.header.tree.signature, core.header.tree.signature)
})

tape('core - update hook is triggered', async function (t) {
  const { core } = await create()
  const { core: clone } = await create({ keyPair: { publicKey: core.header.signer.publicKey } })

  let ran = 0

  core.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b01, 'was appended')
    t.same(from, null, 'was local')
    t.same(bitfield, { drop: false, start: 0, length: 4 })
    ran |= 1
  }

  await core.append([Buffer.from('a'), Buffer.from('b'), Buffer.from('c'), Buffer.from('d')])

  const peer = {}

  clone.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b01, 'was appended')
    t.same(from, peer, 'was remote')
    t.same(bitfield, { drop: false, start: 1, length: 1 })
    t.same(value, Buffer.from('b'))
    ran |= 2
  }

  {
    const p = await core.tree.proof({ block: { index: 1, nodes: 0, value: true }, upgrade: { start: 0, length: 2 } })
    p.block.value = await core.blocks.get(1)
    await clone.verify(p, peer)
  }

  clone.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b00, 'no append or truncate')
    t.same(from, peer, 'was remote')
    t.same(bitfield, { drop: false, start: 3, length: 1 })
    t.same(value, Buffer.from('d'))
    ran |= 4
  }

  {
    const p = await core.tree.proof({ block: { index: 3, nodes: await clone.tree.nodes(6), value: true } })
    p.block.value = await core.blocks.get(3)
    await clone.verify(p, peer)
  }

  core.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b10, 'was truncated')
    t.same(from, null, 'was local')
    t.same(bitfield, { drop: true, start: 1, length: 3 })
    ran |= 8
  }

  await core.truncate(1, 1)

  core.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b01, 'was appended')
    t.same(from, null, 'was local')
    t.same(bitfield, { drop: false, start: 1, length: 1 })
    ran |= 16
  }

  await core.append([Buffer.from('e')])

  clone.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b11, 'was appended and truncated')
    t.same(from, peer, 'was remote')
    t.same(bitfield, { drop: true, start: 1, length: 3 })
    ran |= 32
  }

  {
    const p = await core.tree.proof({ block: { index: 0, nodes: 0, value: false }, upgrade: { start: 0, length: 2 } })
    const r = await clone.tree.reorg(p)

    await clone.reorg(r, peer)
  }

  core.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b10, 'was truncated')
    t.same(from, null, 'was local')
    t.same(bitfield, { drop: true, start: 1, length: 1 })
    ran |= 64
  }

  await core.truncate(1, 2)

  clone.onupdate = (status, bitfield, value, from) => {
    t.same(status, 0b10, 'was truncated')
    t.same(from, peer, 'was remote')
    t.same(bitfield, { drop: true, start: 1, length: 1 })
    ran |= 128
  }

  {
    const p = await core.tree.proof({ block: { index: 0, nodes: 0, value: false }, upgrade: { start: 0, length: 1 } })
    const r = await clone.tree.reorg(p)

    await clone.reorg(r, peer)
  }

  t.same(ran, 255, 'ran all')
})

async function create (opts) {
  const storage = new Map()

  const createFile = (name) => {
    if (storage.has(name)) return storage.get(name)
    const s = new RAM()
    storage.set(name, s)
    return s
  }

  const reopen = () => Core.open(createFile, opts)
  const core = await reopen()
  return { core, reopen }
}