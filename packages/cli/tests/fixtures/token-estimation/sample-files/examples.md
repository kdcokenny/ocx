# Code Examples

## Error Handling Patterns

### Try-Catch with Specific Error Types

Always catch specific error types when possible and handle them appropriately.

```typescript
async function fetchUserData(userId: string): Promise<User> {
  try {
    const response = await fetch(`/api/users/${userId}`)
    
    if (!response.ok) {
      throw new NetworkError(`Failed to fetch user: ${response.statusText}`)
    }
    
    const data = await response.json()
    return parseUser(data)
  } catch (error) {
    if (error instanceof NetworkError) {
      logger.error('Network error while fetching user', { userId, error })
      throw error
    }
    
    if (error instanceof ValidationError) {
      logger.warn('Invalid user data received', { userId, error })
      throw error
    }
    
    logger.error('Unexpected error while fetching user', { userId, error })
    throw new UnknownError('Failed to fetch user data', error)
  }
}
```

### Custom Error Classes

Define custom error classes for domain-specific errors:

```typescript
class NetworkError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message)
    this.name = 'NetworkError'
  }
}

class ValidationError extends Error {
  constructor(message: string, public readonly field: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
```

## Async/Await Patterns

### Parallel Execution

Execute independent async operations in parallel:

```typescript
async function loadDashboardData(userId: string) {
  const [user, posts, comments, stats] = await Promise.all([
    fetchUser(userId),
    fetchUserPosts(userId),
    fetchUserComments(userId),
    fetchUserStats(userId),
  ])
  
  return {
    user,
    posts,
    comments,
    stats,
  }
}
```

### Sequential Execution with Dependencies

When operations depend on previous results:

```typescript
async function createUserWithProfile(userData: UserData) {
  // Create user first
  const user = await createUser(userData)
  
  // Then create profile with user ID
  const profile = await createProfile({
    userId: user.id,
    ...userData.profile,
  })
  
  // Finally, send welcome email
  await sendWelcomeEmail(user.email, user.name)
  
  return { user, profile }
}
```

## Type Safety

### Discriminated Unions

Use discriminated unions for type-safe state management:

```typescript
type Result<T, E> =
  | { success: true; value: T }
  | { success: false; error: E }

function handleResult<T>(result: Result<T, string>) {
  if (result.success) {
    console.log('Success:', result.value)
  } else {
    console.error('Error:', result.error)
  }
}
```

### Exhaustive Checking

Ensure all cases are handled in switch statements:

```typescript
type Status = 'pending' | 'approved' | 'rejected'

function getStatusColor(status: Status): string {
  switch (status) {
    case 'pending':
      return 'yellow'
    case 'approved':
      return 'green'
    case 'rejected':
      return 'red'
    default: {
      const _exhaustive: never = status
      throw new Error(`Unhandled status: ${_exhaustive}`)
    }
  }
}
```
