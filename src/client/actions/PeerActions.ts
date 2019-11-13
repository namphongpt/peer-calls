import * as ChatActions from '../actions/ChatActions'
import * as NotifyActions from '../actions/NotifyActions'
import * as StreamActions from '../actions/StreamActions'
import * as constants from '../constants'
import Peer from 'simple-peer'
import _ from 'underscore'
import _debug from 'debug'
import { play, iceServers } from '../window'
import { Dispatch } from 'redux'

const debug = _debug('peercalls')

export interface Peers {
  [id: string]: Peer.Instance
}

export type GetState = () => { peers: Peers }

export interface PeerHandlerOptions {
  socket: SocketIOClient.Socket
  user: { id: string }
  dispatch: Dispatch
  getState: GetState
}

class PeerHandler {
  socket: SocketIOClient.Socket
  user: { id: string }
  dispatch: Dispatch
  getState: GetState

  constructor (readonly options: PeerHandlerOptions) {
    this.socket = options.socket
    this.user = options.user
    this.dispatch = options.dispatch
    this.getState = options.getState
  }
  handleError = (err: Error) => {
    const { dispatch, getState, user } = this
    debug('peer: %s, error %s', user.id, err.stack)
    NotifyActions.error('A peer connection error occurred')(dispatch)
    const peer = getState().peers[user.id]
    peer && peer.destroy()
    dispatch(removePeer(user.id))
  }
  handleSignal = (signal: unknown) => {
    const { socket, user } = this
    debug('peer: %s, signal: %o', user.id, signal)

    const payload = { userId: user.id, signal }
    socket.emit('signal', payload)
  }
  handleConnect = () => {
    const { dispatch, user } = this
    debug('peer: %s, connect', user.id)
    NotifyActions.warning('Peer connection established')(dispatch)
    play()
  }
  handleStream = (stream: MediaStream) => {
    const { user, dispatch } = this
    debug('peer: %s, stream', user.id)
    dispatch(StreamActions.addStream({
      userId: user.id,
      stream,
    }))
  }
  handleData = (object: any) => {
    const { dispatch, user } = this
    const message = JSON.parse(new window.TextDecoder('utf-8').decode(object))
    debug('peer: %s, message: %o', user.id, object)
    switch (message.type) {
      case 'file':
        dispatch(ChatActions.addMessage({
          userId: user.id,
          message: message.payload.name,
          timestamp: new Date().toLocaleString(),
          image: message.payload.data,
        }))
        break
      default:
        dispatch(ChatActions.addMessage({
          userId: user.id,
          message: message.payload,
          timestamp: new Date().toLocaleString(),
          image: undefined,
        }))
    }
  }
  handleClose = () => {
    const { dispatch, user } = this
    debug('peer: %s, close', user.id)
    NotifyActions.error('Peer connection closed')(dispatch)
    dispatch(StreamActions.removeStream(user.id))
    dispatch(removePeer(user.id))
  }
}

export interface CreatePeerOptions {
  socket: SocketIOClient.Socket
  user: { id: string }
  initiator: string
  stream?: MediaStream
}

/**
 * @param {Object} options
 * @param {Socket} options.socket
 * @param {User} options.user
 * @param {String} options.user.id
 * @param {Boolean} [options.initiator=false]
 * @param {MediaStream} [options.stream]
 */
export function createPeer (options: CreatePeerOptions) {
  const { socket, user, initiator, stream } = options

  return (dispatch: Dispatch, getState: GetState) => {
    const userId = user.id
    debug('create peer: %s, stream:', userId, stream)
    NotifyActions.warning('Connecting to peer...')(dispatch)

    const oldPeer = getState().peers[userId]
    if (oldPeer) {
      NotifyActions.info('Cleaning up old connection...')(dispatch)
      oldPeer.destroy()
      dispatch(removePeer(userId))
    }

    const peer = new Peer({
      initiator: socket.id === initiator,
      config: { iceServers },
      // Allow the peer to receive video, even if it's not sending stream:
      // https://github.com/feross/simple-peer/issues/95
      offerConstraints: {
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      },
      stream,
    })

    const handler = new PeerHandler({
      socket,
      user,
      dispatch,
      getState,
    })

    peer.once(constants.PEER_EVENT_ERROR, handler.handleError)
    peer.once(constants.PEER_EVENT_CONNECT, handler.handleConnect)
    peer.once(constants.PEER_EVENT_CLOSE, handler.handleClose)
    peer.on(constants.PEER_EVENT_SIGNAL, handler.handleSignal)
    peer.on(constants.PEER_EVENT_STREAM, handler.handleStream)
    peer.on(constants.PEER_EVENT_DATA, handler.handleData)

    dispatch(addPeer({ peer, userId }))
  }
}

export interface AddPeerParams {
  peer: Peer.Instance
  userId: string
}

export interface AddPeerAction {
  type: 'PEER_ADD'
  payload: AddPeerParams
}

export const addPeer = (payload: AddPeerParams): AddPeerAction => ({
  type: constants.PEER_ADD,
  payload,
})

export interface RemovePeerAction {
  type: 'PEER_REMOVE'
  payload: { userId: string }
}

export const removePeer = (userId: string): RemovePeerAction => ({
  type: constants.PEER_REMOVE,
  payload: { userId },
})

export interface DestroyPeersAction {
  type: 'PEERS_DESTROY'
}

export const destroyPeers = (): DestroyPeersAction => ({
  type: constants.PEERS_DESTROY,
})

export type PeerAction =
  AddPeerAction |
  RemovePeerAction |
  DestroyPeersAction

export interface TextMessage {
  type: 'text'
  payload: string
}

export interface Base64File {
  name: string
  size: number
  type: string
  data: string
}

export interface FileMessage {
  type: 'file'
  payload: Base64File
}

export type Message = TextMessage | FileMessage

export const sendMessage = (message: Message) =>
(dispatch: Dispatch, getState: GetState) => {
  const { peers } = getState()
  debug('Sending message type: %s to %s peers.',
    message.type, Object.keys(peers).length)
  _.each(peers, (peer, userId) => {
    switch (message.type) {
      case 'file':
        dispatch(ChatActions.addMessage({
          userId: 'You',
          message: 'Send file: "' +
            message.payload.name + '" to peer: ' + userId,
          timestamp: new Date().toLocaleString(),
          image: message.payload.data,
        }))
        break
      default:
        dispatch(ChatActions.addMessage({
          userId: 'You',
          message: message.payload,
          timestamp: new Date().toLocaleString(),
          image: undefined,
        }))
    }
    peer.send(JSON.stringify(message))
  })
}

export const sendFile = (file: File) =>
async (dispatch: Dispatch, getState: GetState) => {
  const { name, size, type } = file
  if (!window.FileReader) {
    NotifyActions.error('File API is not supported by your browser')(dispatch)
    return
  }
  const reader = new window.FileReader()
  const base64File = await new Promise<Base64File>(resolve => {
    reader.addEventListener('load', () => {
      resolve({
        name,
        size,
        type,
        data: reader.result as string,
      })
    })
    reader.readAsDataURL(file)
  })

  sendMessage({ payload: base64File, type: 'file' })(dispatch, getState)
}
