import { Request, Response } from "express";
import { getCollection, parseId } from "../../../modules/mongo";
import { convertListToIds } from "../../../util";
import { validateSchema } from "../../../util/validation";

export const assignBucketsToFriend = async (req: Request, res: Response) => {
	let mongoBucketIds : any[] = await convertListToIds(res.locals.uid, "privacyBuckets", req.body.buckets)

	const result = await getCollection("friends").updateOne({ uid: res.locals.uid, frienduid: req.body.friendUid }, { $set: { privacyBuckets: mongoBucketIds }});
	if (result.modifiedCount === 1)
	{
		res.status(200).send()
		return
	}

	res.status(404).send()
};

export const assignFriendsToBucket = async (req: Request, res: Response) => {
	const bucket = await getCollection("privacyBuckets").findOne({ uid: res.locals.uid, _id: parseId(req.body.bucket) })
	if (!bucket)
	{
		res.status(404).send("Unknown bucket")
		return
	}

	const allFriends = await getCollection("friends").find({uid: res.locals.uid }).toArray()

	const revokeBucketForFriendsFutures = []

	for (let i = 0; i < allFriends.length; ++i)
	{
		revokeBucketForFriendsFutures.push(getCollection("friends").updateOne({ uid: res.locals.uid, frienduid: allFriends[i].frienduid }, { $pull: { privacyBuckets: bucket._id }}))
	}

	await Promise.all(revokeBucketForFriendsFutures)

	const friends : string[] = req.body.friends 

	const assignBucketForFriendsFutures = []

	for (let i = 0; i < friends.length; ++i)
	{
		assignBucketForFriendsFutures.push(getCollection("friends").updateOne({ uid: res.locals.uid, frienduid: friends[i] }, { $push: { privacyBuckets: bucket._id }}))
	}

	await Promise.all(assignBucketForFriendsFutures)

	res.status(200).send()
};

export const validateAssignBucketsToFriendSchema = (body: unknown): { success: boolean; msg: string } => {
	const schema = {
		type: "object",
		properties: {
			friendUid: { type: "string", pattern: "^[A-Za-z0-9]{20,50}$" },
			buckets: { type: "array" , items: { type: "string", pattern: "^[A-Za-z0-9]{20,50}$" }, uniqueItems: true },
		},
		required: ["friendUid", "buckets",],
		nullable: false,
		additionalProperties: false,	
	};

	return validateSchema(schema, body);
};

export const validateAssignFriendsToBucketSchema = (body: unknown): { success: boolean; msg: string } => {
	const schema = {
		type: "object",
		properties: {
			bucket: { type: "string", pattern: "^[A-Za-z0-9]{20,50}$" },
			friends: { type: "array" , items: { type: "string", pattern: "^[a-zA-Z0-9]{1,64}$" }, uniqueItems: true },
		},
		required: ["bucket", "friends",],
		nullable: false,
		additionalProperties: false,	
	};

	return validateSchema(schema, body);
};