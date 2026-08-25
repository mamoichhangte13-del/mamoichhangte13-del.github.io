import { createYoga, createSchema } from 'graphql-yoga'
import { createServer } from 'http'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const typeDefs = /* GraphQL */ `
  enum BookingStatus { CONFIRMED CANCELLED }

  type Resource {
    id: ID!
    name: String!
    capacity: Int!
    createdAt: String!
    bookings: [Booking!]!
  }

  type Booking {
    id: ID!
    title: String!
    resourceId: ID!
    resource: Resource!
    startTime: String!
    endTime: String!
    status: BookingStatus!
    createdAt: String!
    updatedAt: String!
  }

  type BookingEdge { cursor: String! node: Booking! }
  type BookingConnection { edges: [BookingEdge!]! pageInfo: PageInfo! }
  type PageInfo { hasNextPage: Boolean! endCursor: String }

  type AvailabilitySlot { startTime: String! endTime: String! isAvailable: Boolean! conflictingBooking: Booking }

  type Query {
    resources: [Resource!]!
    resource(id: ID!): Resource
    bookings(resourceId: ID, from: String, to: String, first: Int, after: String): BookingConnection!
    checkAvailability(resourceId: ID!, startTime: String!, endTime: String!): AvailabilitySlot!
  }

  type Mutation {
    createResource(name: String!, capacity: Int!): Resource!
    createBooking(resourceId: ID!, title: String!, startTime: String!, endTime: String!): Booking!
    rescheduleBooking(id: ID!, startTime: String!, endTime: String!): Booking!
    cancelBooking(id: ID!): Booking!
    deleteResource(id: ID!): Boolean!
  }
`

const resolvers = {
  Query: {
    resources: () => prisma.resource.findMany({ orderBy: { createdAt: 'desc' } }),
    resource: (_: any, { id }: any) => prisma.resource.findUnique({ where: { id } }),
    bookings: async (_: any, { resourceId, from, to, first = 20, after }: any) => {
      const take = Math.min(first || 20, 50)
      const cursor = after ? { id: after } : undefined
      const where: any = {}
      if (resourceId) where.resourceId = resourceId
      if (from || to) {
        where.startTime = {}
        if (from) where.startTime.gte = new Date(from)
        if (to) where.startTime.lte = new Date(to)
      }
      const nodes = await prisma.booking.findMany({ where, orderBy: { startTime: 'asc' }, take: take + 1, skip: cursor?1:0, cursor })
      const hasNextPage = nodes.length > take
      const sliced = hasNextPage? nodes.slice(0, -1) : nodes
      return { edges: sliced.map((n: any) => ({ cursor: n.id, node: n })), pageInfo: { hasNextPage, endCursor: sliced[sliced.length-1]?.id || null } }
    },
    checkAvailability: async (_: any, { resourceId, startTime, endTime }: any) => {
      const start = new Date(startTime); const end = new Date(endTime)
      if (start >= end) throw new Error('startTime must be before endTime')
      const conflict = await prisma.booking.findFirst({ where: { resourceId, status: 'CONFIRMED', startTime: { lt: end }, endTime: { gt: start } } })
      return { startTime, endTime, isAvailable: !conflict, conflictingBooking: conflict || null }
    }
  },
  Mutation: {
    createResource: (_: any, { name, capacity }: any) => prisma.resource.create({ data: { name, capacity } }),
    createBooking: async (_: any, { resourceId, title, startTime, endTime }: any) => {
      const start = new Date(startTime); const end = new Date(endTime)
      if (start >= end) throw new Error('startTime must be before endTime')
      return prisma.$transaction(async (tx) => {
        const overlap = await tx.booking.findFirst({ where: { resourceId, status: 'CONFIRMED', startTime: { lt: end }, endTime: { gt: start } } })
        if (overlap) throw new Error(`Overlaps with booking ${overlap.id}`)
        return tx.booking.create({ data: { resourceId, title, startTime: start, endTime: end, status: 'CONFIRMED' } })
      })
    },
    rescheduleBooking: async (_: any, { id, startTime, endTime }: any) => {
      const start = new Date(startTime); const end = new Date(endTime)
      if (start >= end) throw new Error('startTime must be before endTime')
      const existing = await prisma.booking.findUnique({ where: { id } })
      if (!existing) throw new Error('Booking not found')
      if (existing.status === 'CANCELLED') throw new Error('Cannot reschedule cancelled booking')
      return prisma.$transaction(async (tx) => {
        const overlap = await tx.booking.findFirst({ where: { resourceId: existing.resourceId, status: 'CONFIRMED', id: { not: id }, startTime: { lt: end }, endTime: { gt: start } } })
        if (overlap) throw new Error(`Overlaps with booking ${overlap.id}`)
        return tx.booking.update({ where: { id }, data: { startTime: start, endTime: end } })
      })
    },
    cancelBooking: (_: any, { id }: any) => prisma.booking.update({ where: { id }, data: { status: 'CANCELLED' } }),
    deleteResource: async (_: any, { id }: any) => { await prisma.resource.delete({ where: { id } }); return true }
  },
  Resource: { bookings: (parent: any) => prisma.booking.findMany({ where: { resourceId: parent.id }, orderBy: { startTime: 'asc' } }) },
  Booking: { resource: (parent: any) => prisma.resource.findUnique({ where: { id: parent.resourceId } }) }
}

const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }) })
const server = createServer(yoga)
server.listen(4000, () => console.log('🚀 Server running at http://localhost:4000/graphql'))