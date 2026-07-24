import Log from './common/logger';
import * as semver from 'semver';
import { ServerVersion } from './serverConfig';

type githubReleasesData = {
    name: string;
};

export type IRelease = {
    version: string;
    build: string;
};

export function splitRelease(release: string): IRelease {
    const regex = /(\d+)\.(\d+)\.(?:(\d+)\.(\d+)|(\d)(\d*))/;

    const match = release.match(regex);
    if (!match) {
        return {version: release, build: ''};
    }

    const [, major, minor, patch4, build4, patchFused, buildFused] = match;

    // Pre-1.99 release scheme
    // 4-part format: 1.96.4.25026 => patch=4, build=25026
    if (patch4 !== undefined && build4 !== undefined) {
        return {version: `${major}.${minor}.${patch4}`, build: build4};
    }

    // Release scheme starting with 1.99
    // 3-part fused format: 1.112.02593 => patch=0, build=2593
    // Can also catch version without build: 1.112.0 => patch=0, build=''
    return {version: `${major}.${minor}.${patchFused}`, build: buildFused ?? ''};
}

export async function fetchRelease(serverDownloadUrlTemplate: string, version: string, build: string, objective: ServerVersion, logger: Log): Promise<IRelease> {
    // Just match the given version/build
    if (objective === 'match') {
        return {version, build};
    }

    const downloadUrl = new URL(serverDownloadUrlTemplate);
    const hostname = downloadUrl.hostname;
    if (hostname !== 'github.com') {
        logger.info('Can only fetch releases on github repositories');
        return {version, build};
    }

    // Fetch github releases following: https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28
    logger.info(`Fetch the VSCodium release corresponding to the ${objective} release, with local version ${version}-${build}`);

    const parts = downloadUrl.pathname.split('/');
    if (parts.length < 3) {
        logger.info('Cannot parse the Github repository from the url template: ' + downloadUrl);
        return {version, build};
    }
    // per_page=100 (Github's max) so a repository with more than the default
    // 30 releases doesn't silently hide the release we're looking for.
    const apiUrl = `https://api.github.com/repos/${parts[1]}/${parts[2]}/releases?per_page=100`;

    let found: IRelease | undefined;
    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            // Never hang indefinitely on a stalled connection.
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            if (response.status === 403) {
                logger.info(`Github API rate limit exceeded while fetching releases from ${apiUrl}`);
            } else {
                logger.info(`Failed to fetch releases from ${apiUrl}: ${response.status} ${response.statusText}`);
            }
            return {version, build};
        }

        const data = await response.json() as Array<githubReleasesData>;

        // Parse and sort all releases descending by (version, build).
        // Sorting used to compare `${version}-${build}` as a single semver
        // string, but semver rejects numeric prerelease identifiers with
        // leading zeros (e.g. build "03593"), silently dropping otherwise
        // legit releases. Validate/sort the version and build separately.
        const releases = data
            .map(releaseInfo => splitRelease(releaseInfo.name))
            .filter(r => semver.valid(r.version))
            .sort((a, b) => {
                const versionCompare = semver.rcompare(a.version, b.version);
                if (versionCompare !== 0) {
                    return versionCompare;
                }
                return Number(b.build || 0) - Number(a.build || 0);
            });

        if (objective === 'latest') {
            // Latest version
            found = releases[0];
        } else if (objective === 'closest') {
            // Newest release whose version matches the requested version
            found = releases.find(r => r.version === version);
        } else {
            // Specific version+release or version match.
            // Normalize the objective through splitRelease so a pin can be
            // written in any of the supported schemes (e.g. the pre-1.99
            // dot-separated "1.96.4.25026") and still match a release parsed
            // from a differently-formatted name — comparing the raw
            // concatenation `${r.version}${r.build}` against the objective
            // string lost the separator and never matched.
            const target = splitRelease(objective);
            found = releases.find(r =>
                r.version === target.version && (target.build === '' || r.build === target.build)
            );
        }

        // Add error message to help debugging
        if (!found) {
            logger.info(`Cannot find the ${objective} release from the list of existing releases: ${releases}`);
        }

    } catch (error) {
        logger.error('Error fetching releases:', error);
    }

    if (found) {
        logger.info(`Found release for "${objective}": ${found.version}-${found.build}`);
        return found;
    }

    logger.info(`No matching release found for "${objective}", falling back to the local version ${version}-${build}`);
    return {version, build};
}
