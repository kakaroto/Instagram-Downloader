import { BASE_URL, API_FACEBOOK_ACCOUNT, API_QUERY, API_REELS, API_FEED_TEMPLATE, API_GRAPHQL } from "./config.js"
import { existsSync, readFileSync, writeFileSync, createWriteStream } from "fs"
import { mkdir, writeFile, utimes } from "fs/promises"
import { dirname, join, parse } from "path"
import { fileURLToPath } from "url"
import GetCorrectContent from "./helpers/GetCorrectContent.js"
import ValidateUsername from "./helpers/ValidateUsername.js"
import FindRegexArray from "./helpers/FindRegexArray.js"
import GetURLFilename from "./helpers/GetURLFilename.js"
import Question from "./helpers/Question.js"
import dotenv from "dotenv"
import Queue from "./Queue.js"
import axios from "axios"
import sharp from "sharp"
import mime from "mime"
import filenamify from 'filenamify';
import Log from "./helpers/Log.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const root = join(__dirname, "..")
const configPath = join(root, "config.json")

const isTesting = process.env.npm_command === "test" || process.env.npm_lifecycle_event === "test"

Object.assign(axios.defaults.headers.common, {
	"Accept-Encoding": "gzip, deflate, br",
	"Accept-Language": "en-US,en;q=0.9",
	Dnt: "1",
	Dpr: "1",
	"Sec-Ch-Ua-Full-Version-List": '"Chromium";v="134.0.6998.177", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="134.0.6998.177"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Model": '""',
	"Sec-Ch-Ua-Platform": '"Windows"',
	"Sec-Ch-Ua-Platform-Version": '"19.0.0"',
	"Sec-Fetch-Dest": "empty",
	"Sec-Fetch-Mode": "cors",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
})

Object.assign(axios.defaults.headers.get, {
	"Viewport-Width": "1920"
})

const userIdRegexArray = [
	/{"id":"(\d+)","profile_pic_url"/,
	/{"query_id":"\d+","user_id":"(\d+)"/,
	/{"content_type":"PROFILE","target_id":"(\d+)"}/,
	/"profile_id":"(\d+)"/,
	/profilePage_(\d+)/,
]

const fbTokenRegexArray = [
	/"s":"XPolarisProfileController","w":0,"f":"([\w-]+:\d+:\d+)","l":/,
	/"token":"([\w-]+:\d+:\d+)"/
]

let DEBUG = (...args) => {}
export default class Downloader {
	/** @type {import("./typings/api.js").APIHeaders} */ headers = {
		Accept: "*/*",
		Origin: BASE_URL
	}

	/** @type {string} */ output
	/** @type {string[]} */ usernames
	/** @type {number | undefined} */ limit
	/** @type {import("./typings/index.d.ts").Config} */ config
	/** @type {Queue<ReturnType<typeof this.Download>>} */ queue
	/** @type {string | undefined} */ fbToken
	/** @type {boolean} */ flat_dirs

	isEnvSet = false

	/**
	 * @param {string | string[]} usernames
	 * @param {number} queue
	 * @param {number} [limit]
	 */
	constructor(usernames, queue, limit){
		if(Array.isArray(usernames)){
			this.usernames = Array.from(new Set(usernames))

			for(let index = this.usernames.length - 1; index >= 0; index--){
				const username = this.usernames[index]

				try{
					ValidateUsername(username)
				}catch(error){
					Log(new Error(/** @type {string} */ (error)))
					this.usernames.splice(index, 1)
				}
			}
		}else{
			ValidateUsername(usernames)
			this.usernames = [usernames]
		}

		this.limit = limit
		this.queue = new Queue(queue)
		this.flat_dirs = false
	}
	SetConfig(){
		if(!existsSync(configPath)){
			const { TOKEN, USER_ID, SESSION_ID } = process.env

			this.config = {
				cookie: {
					csrftoken: TOKEN,
					ds_user_id: USER_ID,
					sessionid: SESSION_ID
				},
				csrftoken: TOKEN
			}

			this.WriteConfig(true)

			return this.config
		}

		/** @type {import("./typings/index.d.ts").Config} */
		const config = this.config = JSON.parse(readFileSync(configPath, "utf8"))

		if(!config || typeof config !== "object") throw new TypeError("Invalid type from config.json")
		if(!config.cookie) config.cookie = {}

		this.UpdateHeaders()

		return config
	}
	WriteConfig(sync = false){
		if(isTesting){
			// When not in test environment, the headers will be updated
			// after validating the .env file and the process.env variables.
			this.UpdateHeaders()
			return
		}

		const data = JSON.stringify(this.config, null, "\t") + "\n"

		if(sync){
			writeFileSync(configPath, data, "utf8")
			this.SetEnv(true)
			return
		}

		return Promise.all([
			writeFile(configPath, data, "utf8"),
			this.SetEnv(false)
		])
	}
	SetEnv(sync = false){
		if(isTesting || this.isEnvSet) return

		const { config } = this
		const envPath = join(root, ".env")

		if(existsSync(envPath)) dotenv.config({ path: envPath })

		const data = {
			TOKEN: process.env.TOKEN || config.csrftoken,
			USER_ID: process.env.USER_ID || config.cookie.ds_user_id,
			SESSION_ID: process.env.SESSION_ID || config.cookie.sessionid
		}

		this.config.csrftoken = this.config.cookie.csrftoken = data.TOKEN
		this.config.cookie.ds_user_id = data.USER_ID
		this.config.cookie.sessionid = data.SESSION_ID

		this.UpdateHeaders()

		const envString = Object.entries(data).map(([key, value]) => {
			if(!value) return
			return `${key}=${value}`
		}).filter(Boolean).join("\n") + "\n"

		this.isEnvSet = true

		if(sync) writeFileSync(envPath, envString, "utf8")
		else return writeFile(envPath, envString, "utf8")
	}
	UpdateHeaders(){
		const { headers, config } = this
		const { csrftoken, app_id, cookie } = config || {}
		const token = csrftoken || cookie.csrftoken

		if(token) headers["X-Csrftoken"] = token
		if(app_id) headers["X-Ig-App-Id"] = app_id

		headers.Cookie = Object.entries(cookie).map(([key, value]) => `${key}=${value || ""}`).join("; ")
	}
	/** @param {Pick<import("./typings/index.d.ts").Options, "output" | "timeline" | "highlights" | "stories" | "hcover" | "debug" | "flat_dirs">} data */
	async Init({ output, timeline, highlights, hcover, stories, debug, flat_dirs }){
		Log("Initializing")
		DEBUG = debug ? Log : (...args) => {}
		this.flat_dirs = flat_dirs

		if(!this.usernames.length) throw "There are no valid usernames"

		this.SetConfig()

		await this.CheckServerConfig()

		do{
			try{
				if (highlights) {
					// Highlights require a valid session
					await this.CheckLogin()
					Log("Logged in")
				}
				break
			}catch{
				Log(new Error("You are not logged in. Type your data for authentication."))

				const id = (await Question("User id: ")).trim()
				const token = (await Question("CSRF Token: ")).trim()
				const session = (await Question("Session id: ")).trim()

				if(!token || !id || !session) continue

				this.config.csrftoken = this.config.cookie.csrftoken = token
				this.config.cookie.ds_user_id = id
				this.config.cookie.sessionid = session

				this.WriteConfig(true)
			}
		}while(true)

		let errored = 0

		for(const username of this.usernames){
			const userId = await this.GetUserId(username)
			DEBUG(`User '${username}' has ID: ${userId}`)
			try{
				if(!userId) throw new Error(`Failed to get user ID: ${username}`)

				const { is_private, friendship_status: { following } } = await this.GetUser(userId, username)
					// Make the GetUser call non fatal
					.catch(err => {
						DEBUG("GetUser error:", err)
						return { is_private: false, friendship_status: { following: false } }
					})

				if(is_private && !following) throw new Error(`You don't have access to a private account: ${username}`)
			}catch(error){
				Log(error)
				errored++
				continue
			}

			Log(`Downloading from user: ${username}, id: ${userId}`)

			const folder = join(output, username)

			const results = await Promise.allSettled([
				timeline && this.DownloadTimeline(username, folder),
				highlights && this.DownloadHighlights(userId, folder, hcover, this.limit, username),
				stories && this.DownloadStories(userId, folder, this.limit, username)
			])

			let resultsErrored = 0

			for(const result of results){
				if(result.status === "rejected"){
					const { reason } = result
					if(reason instanceof Error) reason.stack = `Failed to download user's content: ${username}`
					Log(reason)
					resultsErrored++
				}
			}

			// If no content was downloaded
			if(resultsErrored === results.length) errored++
		}

		// If all downloads failed
		if(errored === this.usernames.length) process.exitCode = 1
	}
	async CheckLogin(){
		/** @type {import("axios").AxiosResponse<import("./typings/api.js").FacebookAccountAPIResponse>} */
		const response = await this.Request(new URL(API_FACEBOOK_ACCOUNT, BASE_URL), "POST", {
			headers: { Referer: BASE_URL + "/" },
			responseType: "json",
			maxRedirects: 0
		})

		DEBUG("CheckLogin:", typeof response?.data, response?.data)
		if(typeof response?.data === "object" && "status" in response.data){
			const { status, message } = response.data
			if(status === "ok") return
			if (message) throw new Error(`User is not logged in: ${message}`)
		}

		throw new Error("User is not logged in")
	}
	/**
	 * @param {string} userId
	 * @param {string} [username]
	 */
	async GetUser(userId, username){
		const { fbToken } = this

		/** @type {import("axios").AxiosResponse<import("./typings/api.js").QueryUserAPIResponse>} */
		const response = await this.Request(new URL(API_GRAPHQL, BASE_URL), "POST", {
			data: new URLSearchParams({
				fb_dtsg: fbToken,
				variables: JSON.stringify({
					id: userId,
					render_surface: "PROFILE"
				}),
				doc_id: "25313068075003303"
			}),
			headers: {
				Referer: username ? this.GetUserProfileLink(username) : BASE_URL + "/"
			},
			responseType: "json"
		})

		if(typeof response?.data === "object"){
			const { data } = response.data

			if(data && "user" in data) return data.user

			throw new Error(`Failed to get user: ${username} (${userId})`)
		}

		throw new Error(`User not found: ${username}`)
	}
	/** @param {string} username */
	GetUserProfileLink(username){
		return `${BASE_URL}/${username}/`
	}
	/** @param {string} username */
	async GetUserId(username){
		const url = this.GetUserProfileLink(username)

		try{
			/** @type {import("axios").AxiosResponse<string>} */
			const { data } = await this.Request(url, "GET", {
				headers: {
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
					Priority: "u=0, i",
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-User": "?1",
					"X-Csrftoken": undefined,
					"X-Ig-App-Id": undefined
				},
				responseType: "text"
			})

			try{
				const fbToken = FindRegexArray(data, fbTokenRegexArray)
				if(!fbToken) throw "Token was not found"

				this.fbToken = fbToken
			}catch(error){
				Log(new Error("Failed to set facebook token", { cause: error }))
			}

			return FindRegexArray(data, userIdRegexArray) || null
		}catch(error){
			throw new Error(`Failed to get user ID (${username})`, { cause: error })
		}
	}
	/**
	 * @param {string} user_id
	 * @param {string} [username]
	 */
	async GetHighlights(user_id, username){
		const { config } = this

		/** @type {import("axios").AxiosResponse<import("./typings/api.js").QueryHighlightsAPIResponse>} */
		const response = await this.Request(new URL(API_QUERY, BASE_URL), "POST", {
			data: new URLSearchParams({
				variables: JSON.stringify({ user_id }),
				doc_id: "8298007123561120"
			}),
			headers: {
				Referer: username ? this.GetUserProfileLink(username) : BASE_URL + "/"
			},
			responseType: "json"
		})

		try{
			const { cookie: { sessionid } } = config
			const { vary } = response.headers

			if(
				!vary ||
				!sessionid ||
				sessionid === '""' ||
				!vary.includes("Cookie")
			) throw "Login session expired"

			const { data: { highlights } } = response.data

			return highlights.edges.map(({ node }) => node)
		}catch(error){
			if(typeof error === "string") throw new Error(error)

			throw new Error(`Failed to get user (${username || user_id}) highlights`, {
				cause: /** @type {Error} */ (error).message.replace(/\[?Error\]?:? ?/, "")
			})
		}
	}
	/**
	 * @param {import("./typings/api.js").HighlightId[]} reelsIds
	 * @param {string} [username]
	 * @param {number} [first]
	 */
	async GetHighlightsContents(reelsIds, username, first){
		first ??= this.queue?.limit ?? 10

		/**
		 * @type {import("axios").AxiosResponse<
		 * 	| import("./typings/api.js").HighlightsAPIResponse
		 * 	| import("./typings/api.js").GraphAPIResponseError
		 * >
		 * } */
		const response = await this.Request(new URL(API_QUERY, BASE_URL), "POST", {
			data: new URLSearchParams({
				variables: JSON.stringify({
					after: null,
					before: null,
					first: reelsIds.length,
					initial_reel_id: reelsIds[0],
					reel_ids: reelsIds,
					last: null
				}),
				doc_id: "25536143079310158"
			}),
			headers: {
				Referer: username ? this.GetUserProfileLink(username) : BASE_URL + "/"
			},
			responseType: "json"
		})

		const { xdt_api__v1__feed__reels_media__connection: feed } = response.data.data || {}

		if(!feed){
			const { errors } = /** @type {import("./typings/api.js").GraphAPIResponseError} */ (response.data)
			const error = errors?.[0]
			throw new Error(`Error downloading highlights ${error ? `(${error.severity}): ${error.message}` : ""}`)
		}

		DEBUG("GetHighlightsContents:", JSON.stringify(feed, undefined, 2))
		return feed.edges.map(({ node }) => node)
	}
	/**
	 * @param {`${number}`} userId
	 * @param {string} [username]
	 */
	async GetStories(userId, username){
		const url = new URL(API_REELS, BASE_URL)

		url.searchParams.set("reel_ids", userId)

		/** @type {import("axios").AxiosResponse<import("./typings/api.js").StoriesAPIResponse>} */
		const response = await this.Request(url, "GET", {
			headers: { Referer: username ? this.GetUserProfileLink(username) : BASE_URL + "/" },
			responseType: "json"
		})

		if(typeof response?.data === "object"){
			const { reels, reels_media } = response.data
			DEBUG("GetStories:", JSON.stringify(response.data, undefined, 2))
			return reels_media.length ? reels[userId] : null
		}

		return null
	}
	/**
	 * @param {string} user_id
	 * @param {string} folder
	 * @param {boolean} [hcover]
	 * @param {number} [limit]
	 * @param {string} [username]
	 */
	async DownloadHighlights(user_id, folder, hcover, limit = Infinity, username){
		const highlights = await this.GetHighlights(user_id, username)

		const highlightsMap = new Map(highlights.map(reel => [reel.id, reel]))

		const filesSet = /** @type {Set<string>} */ (new Set)
		let hasHighlights = Boolean(highlights.length)
		let count = 0

		while(highlights.length && limit > count){
			const ids = highlights.splice(0, 10).map(({ id }) => id)
			const highlightsContents = await this.GetHighlightsContents(ids, username)

			if(!highlightsContents) throw new Error("No highlights found. The request might have been forbidden")

			if(!highlightsContents.length){
				hasHighlights = false
				break
			}

			for(const { id, items, title } of highlightsContents){
				if(count > limit) throw new Error("Unexpected error")

				Log(`Downloading highlight: '${title}' (${id.substring(id.indexOf(":") + 1)})`)
				let target_dir = this.flat_dirs ? folder : join(folder, "highlights", filenamify(title))
				if(items.length > 0 && !existsSync(target_dir)) await mkdir(target_dir, { recursive: true })

				for(const item of items){
					const { url } = GetCorrectContent(item)[0]
					filesSet.add(GetURLFilename(url))
				}

				const shouldDownloadCover = hcover && highlightsMap.has(id)
				let coverUrl

				if(shouldDownloadCover){
					const { cropped_image_version: { url } } = highlightsMap.get(id).cover_media
					coverUrl = url
				}

				const data = { count, limit }
				const { urls, limited } = await this.DownloadItems(items, target_dir, data, username)

				count = data.count

				// Might not download cover if limit is set
				if(shouldDownloadCover && coverUrl && !urls.has(coverUrl) && !(count === limit || limited)){
					const coverFilename = GetURLFilename(coverUrl)
					const filenames = Array.from(urls).map(GetURLFilename)

					if(!filenames.includes(coverFilename)){
						count++

						try{
							await this.Download(coverUrl, target_dir, new Date)
						}catch(error){
							Log(error)
						}
					}
				}

				if(limited) break
			}
		}

		if(hasHighlights){
			if(count === 0) Log("No content found in the highlights")
		}else Log("No highlights found")
	}
	/**
	 * @param {string} user_id
	 * @param {string} folder
	 * @param {number} [limit]
	 * @param {string} [username]
	 */
	async DownloadStories(user_id, folder, limit = Infinity, username){
		const results = await this.GetStories(/** @type {`${number}`} */ (user_id), username)

		if(!results) return Log("No stories found")

		const { items: stories } = results

		const target_dir = this.flat_dirs ? folder : join(folder, "stories")
		if(stories.length){
			if(!existsSync(target_dir)) await mkdir(target_dir, { recursive: true })
			Log("Downloading stories")
		}

		let count = 0

		while(stories.length && limit > count){
			const items = stories.splice(0, 10)
			const data = { count, limit }
			const { limited } = await this.DownloadItems(items, target_dir, data, username)

			count = data.count

			if(limited) break
		}
	}
	/**
	 * @param {string} username
	 * @param {string} folder
	 * @param {number} [limit]
	 */
	async DownloadTimeline(username, folder, limit = Infinity){
		const url = new URL(API_FEED_TEMPLATE.replace("<username>", username), BASE_URL)

		url.searchParams.set("count", "12")

		/** @type {string} */
		let lastId
		let first = true
		let count = 0
		let hasMore = true

		while(hasMore && limit > count){
			if(lastId) url.searchParams.set("max_id", lastId)

			/** @type {import("axios").AxiosResponse<import("./typings/api.js").FeedAPIResponse>} */
			const response = await this.Request(url)

			if(typeof response?.data === "object"){
				const { more_available, num_results, next_max_id, items } = response.data

				if(!Array.isArray(items)) throw new Error(`Couldn't get user timeline, user: ${username}`)
				if(!items.length) throw new Error(`No items found in timeline, user: ${username}`)

				if(num_results === 0) break

				if(first){
					Log("Downloading timeline")
					first = false
				}

				const target_dir = this.flat_dirs ? folder : join(folder, "timeline")
				await mkdir(target_dir, { recursive: true })

				const data = { count, limit }
				const { limited } = await this.DownloadItems(items, target_dir, data, username)

				if(limited) break

				hasMore = more_available
				lastId = next_max_id
				count = data.count
			}else Log(new Error("Failed to get timeline, lastId: " + (lastId || null)))
		}

		if(count === 0) Log("No content found in timeline")
	}
	/**
	 * @param {(import("./typings/api.js").FeedItem | import("./typings/api.js").GraphHighlightsMedia | import("./typings/api.js").GraphReelsMedia)[]} items
	 * @param {string} folder
	 * @param {{ count: number, limit: number }} [data]
	 * @param {string} [username]
	 */
	async DownloadItems(items, folder, data, username){
		/** @type {Map<string, Date>} */
		const urls = new Map
		const folders = new Map

		const shouldLimit = data && typeof data.limit === "number"
		let limited = false

		if(shouldLimit && !data.limit) return {
			urls: /** @type {Set<string>} */ (new Set),
			limited: true
		}

		/**
		 * @param {typeof items[number]} item
		 * @param {Date} date
		 * @param {string} folder
		 */
		function Carousel(item, date, folder){
			for(const media of item.carousel_media){
				if(shouldLimit && data.count >= data.limit){
					limited = true
					break
				}

				const { url } = GetCorrectContent(media)[0]
				urls.set(url, date)
				folders.set(url, folder)

				data.count++
			}
		}

		for(const item of items){
			if(shouldLimit && data.count >= data.limit){
				limited = true
				break
			}

			const date = new Date(item.taken_at * 1000)

			if(item.carousel_media_count){
				const target_dir = this.flat_dirs ? folder : join(folder, "carousel", item.pk)
				if(item.carousel_media.length > 0 && !existsSync(target_dir)) await mkdir(target_dir, { recursive: true })
				Carousel(item, date, target_dir)
				if(limited) break
				continue
			}

			const { url } = GetCorrectContent(item)[0]
			urls.set(url, date)
			folders.set(url, folder)

			data.count++
		}

		await Promise.all(Array.from(urls.entries()).map(async ([url, date]) => {
			try{
				await this.Download(url, folders.get(url) || folder, date, undefined, {
					headers: { Referer: username ? this.GetUserProfileLink(username) : BASE_URL + "/" }
				})
			}catch(error){
				Log(error instanceof Error ? error : new Error(String(error)))
				urls.delete(url)
			}
		}))

		return {
			urls: new Set(urls.keys()),
			limited
		}
	}
	/**
	 * @param {string} url
	 * @param {string} folder
	 * @param {Date | number} [date]
	 * @param {string} [filename]
	 * @param {import("axios").AxiosRequestConfig} [config]
	 * @returns {Promise<string | undefined>}
	 */
	async Download(url, folder, date = new Date, filename = "", config = {}){
		if(!filename) filename = GetURLFilename(url)

		const { name, ext } = parse(filename)

		const path = join(folder, filename)
		if (existsSync(path)) {
			// Skip re-download of already downloaded content
			// TODO: need to check for all files with the same name but different extension due to the use of sharp for correct extension
			return path
		}
		if(/^image\/.+$/.test(mime.getType(ext))) return this.queue.add(async () => {
			Object.assign(config, { responseType: "arraybuffer" })

			/** @type {import("axios").AxiosResponse<Buffer>} */
			const { data, status } = await this.Request(url, "GET", config)

			if(status < 200 || status >= 300){
				Log(new Error(`Request to media ${filename} failed with status ${status}`))
				return
			}

			const { format } = await sharp(data).metadata()
			const path = join(folder, `${name}.${format === "jpeg" ? "jpg" : format}`)

			await writeFile(path, data)
			await utimes(path, new Date, date)

			return path
		})

		return this.queue.add(async () => {
			Object.assign(config, { responseType: "stream" })

			/** @type {import("axios").AxiosResponse<import("stream").PassThrough>} */
			const { data } = await this.Request(url, "GET", config)
			const path = join(folder, filename)
			const file = createWriteStream(path)

			return new Promise((resolve, reject) => {
				file.on("close", () => utimes(path, date, date).then(() => resolve(path)).catch(reject))
				file.on("error", reject)
				data.pipe(file)
			})
		})
	}
	/**
	 * @template T
	 * @param {string | URL} url
	 * @param {"GET" | "POST"} [method]
	 * @param {Omit<import("axios").AxiosRequestConfig, "url" | "method">} [config]
	 */
	async Request(url, method = "GET", config = {}){
		config.headers = {
			...this.headers,
			...(config.headers || {})
		}

		let _url

		if(url instanceof URL){
			_url = url
			url = url.href
		}else{
			_url = new URL(url)
		}

		config.headers = {
			Host: _url.host,
			Origin: _url.origin,
			"Sec-Fetch-Site": BASE_URL === _url.origin ? "same-origin" : "cross-site",
			...config.headers
		}

		try{
			/** @type {import("axios").AxiosResponse<T>} */
			const response = await axios({
				url,
				method,
				validateStatus: () => true,
				...config
			})

			if(!this.config) this.SetConfig()

			response?.headers["set-cookie"]?.forEach(cookieConfig => {
				const [key, ...values] = cookieConfig.split(";")[0].split("=")

				if(key === "th_eu_pref") return

				const value = encodeURIComponent(values.join("="))

				if(key === "csrftoken") this.config.csrftoken = value
				this.config.cookie[key] = value
			})

			await this.WriteConfig()

			return response
		}catch(error){
			throw error instanceof Error ? new Error(error.name.replace(/\[?Error\]?:? ?/, ""), { cause: error.message }) : error
		}
	}
	async CheckServerConfig(){
		const { config } = this

		if(config.app_id) return

		const response = await this.Request(new URL("/", BASE_URL), "GET", { responseType: "text" })

		if(typeof response?.data === "string"){
			try{
				const appId = response.data.match(/"X-IG-App-ID":"(\d+)"/)?.[1]
				if(!appId) throw "App ID was not found"

				config.app_id = appId
			}catch(error){
				Log(new Error("Failed to set App ID", { cause: error }))
			}

			try{
				const fbToken = FindRegexArray(response.data, fbTokenRegexArray)
				if(!fbToken) throw "Token was not found"

				this.fbToken = fbToken
			}catch(error){
				Log(new Error("Failed to set Facebook token", { cause: error }))
			}

			this.UpdateHeaders()
		}
	}
}
