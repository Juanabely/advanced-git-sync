// src/structures/gitlab/helpers/gitlabBranches.ts

import { Branch, Config, BranchFilterOptions } from '@/src/types'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as path from 'path'
import * as fs from 'fs'

export class gitlabBranchHelper {
  private repoPath: string | null = null

  constructor(
    private gitlab: any,
    private config: Config,
    private getProjectId: () => Promise<number>
  ) {}

  private getRepoPathFromConfig(): string | null {
    const owner = this.config.gitlab.owner
    const repo = this.config.gitlab.repo

    if (owner && repo) {
      return `${owner}/${repo}`
    }

    return null
  }

  async fetch(filterOptions?: BranchFilterOptions): Promise<Branch[]> {
    core.info('\x1b[36m🌿 Fetching GitLab Branches...\x1b[0m')

    const projectId = await this.getProjectId()
    const branches = await this.gitlab.Branches.all(projectId)
    // Extract repo path from first branch API URL
    if (branches.length > 0 && !this.repoPath) {
      const apiUrl = branches[0]._links?.self || ''
      const match = apiUrl.match(/projects\/(.+?)\/repository/)
      if (match) {
        this.repoPath = decodeURIComponent(match[1])
        core.debug(`Extracted repo path: ${this.repoPath}`)
      }
    }

    interface GitLabBranch {
      name: string
      commit: { id: string }
      protected: boolean
    }

    // Map branches to our internal format
    let processedBranches: Branch[] = branches.map((branch: GitLabBranch) => ({
      name: branch.name,
      sha: branch.commit.id,
      protected: branch.protected
    }))

    if (filterOptions) {
      if (filterOptions.includeProtected === false) {
        processedBranches = processedBranches.filter(
          branch => !branch.protected
        )
      }

      if (filterOptions.pattern) {
        const safePattern = filterOptions.pattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')
        const regex = new RegExp(safePattern)
        processedBranches = processedBranches.filter(branch =>
          regex.test(branch.name)
        )
        core.info(
          `\x1b[36m🔍 Filtering branches with pattern: ${filterOptions.pattern}\x1b[0m`
        )
      }
    }

    core.info(
      `\x1b[32m✓ Branches Fetched: ${processedBranches.length} branches (${processedBranches.map((branch: Branch) => branch.name).join(', ')})\x1b[0m`
    )
    return processedBranches
  }

  async update(name: string, commitSha: string): Promise<void> {
    const gitlabUrl = this.config.gitlab.host || 'https://gitlab.com'
    let repoPathStr = ''

    if (this.repoPath) {
      repoPathStr = `${gitlabUrl}/${this.repoPath}.git`
    } else {
      const configPath = this.getRepoPathFromConfig()
      if (configPath) {
        repoPathStr = `${gitlabUrl}/${configPath}.git`
      } else if (this.config.gitlab.projectId) {
        // Fetch the project details to get the actual path string for git
        try {
          const projectDetails = await this.gitlab.Projects.show(
            this.config.gitlab.projectId
          )
          if (projectDetails && projectDetails.path_with_namespace) {
            this.repoPath = projectDetails.path_with_namespace
            repoPathStr = `${gitlabUrl}/${this.repoPath}.git`
          } else {
            throw new Error(
              'Project details did not contain path_with_namespace'
            )
          }
        } catch (error) {
          throw new Error(
            `Failed to fetch project details for projectId ${this.config.gitlab.projectId}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      } else {
        throw new Error('Could not determine repository path')
      }
    }

    const tmpDir = path.join(process.cwd(), '.tmp-git')
    try {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true })
      }

      await exec.exec('git', ['init'], { cwd: tmpDir })
      await exec.exec('git', ['config', 'user.name', 'advanced-git-sync'], {
        cwd: tmpDir
      })
      await exec.exec(
        'git',
        ['config', 'user.email', 'advanced-git-sync@users.noreply.github.com'],
        { cwd: tmpDir }
      )

      const githubUrl = `https://x-access-token:${this.config.github.token}@github.com/${this.config.github.owner}/${this.config.github.repo}.git`
      await exec.exec('git', ['remote', 'add', 'github', githubUrl], {
        cwd: tmpDir
      })

      await exec.exec('git', ['fetch', 'github', commitSha], { cwd: tmpDir })

      const gitlabAuthUrl = `https://oauth2:${this.config.gitlab.token}@${repoPathStr.replace(/^https?:\/\//, '')}`
      await exec.exec('git', ['remote', 'add', 'gitlab', gitlabAuthUrl], {
        cwd: tmpDir
      })

      console.log(`git push -f gitlab ${commitSha}:refs/heads/${name}`)
      await exec.exec(
        'git',
        ['push', '-f', 'gitlab', `${commitSha}:refs/heads/${name}`],
        { cwd: tmpDir }
      )
    } finally {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    }
  }

  async create(name: string, commitSha: string): Promise<void> {
    await this.update(name, commitSha)
  }
}
